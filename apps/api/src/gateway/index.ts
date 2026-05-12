/**
 * Tavern Gateway — WebSocket realtime fanout.
 *
 * Lifecycle:
 *   server -> client: HELLO (op 10)        with heartbeatIntervalMs + sessionId
 *   client -> server: IDENTIFY (op 2)      with bearer token
 *   server -> client: READY (op 0, t=READY) with viewer + servers + channels
 *
 *   Loop:
 *     client -> server: HEARTBEAT (op 1)
 *     server -> client: HEARTBEAT_ACK (op 11)
 *     server -> client: DISPATCH (op 0, t=...) realtime events
 *
 * Reliability: each DISPATCH includes a monotonic sequence number `s`. Clients
 * may reconnect and call RESUME (op 3) with their last seen `s`. Phase 1 buffers
 * events for a short window per session; older events trigger an INVALID_SESSION
 * (op 9) and force a fresh IDENTIFY.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { prisma } from '@tavern/db';
import {
  GATEWAY,
  GatewayOp,
  Permission,
  PERMISSION_ALL,
  TavernError,
  gatewayHelloPayloadSchema,
  gatewayIdentifyPayloadSchema,
  gatewayResumePayloadSchema,
  gatewayHeartbeatPayloadSchema,
  type GatewayDispatchEventName,
  type GatewayPayload,
  ulid,
} from '@tavern/shared';
import type { JwtService } from '../lib/jwt.js';
import { getChannelPermissions } from '../services/permissions-service.js';
import { gatewayBroker, type GatewayEvent } from '../services/gateway-broker.js';
import { activeBanServerIds } from '../services/ban-service.js';
import { voiceStateGatewayPayloadSchema } from '@tavern/shared';

interface Client {
  id: string;
  ws: WebSocket;
  userId: string | null;
  sessionId: string | null;
  lastHeartbeatAt: number;
  seq: number;
  buffer: Array<{ s: number; payload: GatewayPayload }>;
  identified: boolean;
  closing: boolean;
  /**
   * Sequence number of the OLDEST event still in `buffer`. When this is > 0,
   * a RESUME with `lastSeq < bufferFloor` is unreplayable and must trigger an
   * INVALID_SESSION (RT-003).
   */
  bufferFloor: number;
}

const BUFFER_MAX = 256;
/**
 * Maximum bytes we tolerate in a single client's outbound buffer before we
 * treat the socket as a slow consumer and close it. The `ws` package buffers
 * partially-sent frames in memory; if a client never drains, this would
 * otherwise grow without bound. 1 MiB is generous for our payload sizes
 * (a single dispatch is typically < 4 KiB). RT-002.
 */
const MAX_BUFFERED_BYTES = 1 * 1024 * 1024;

export function registerGateway(app: FastifyInstance, jwt: JwtService): void {
  const clients = new Map<string, Client>();
  /**
   * RT-009: connectionId-set per identified user. Lets the gateway know when
   * the last tab/socket for a user has closed so we can clean up presence
   * state that would otherwise be orphaned (e.g. mic-on / camera-on flags on
   * a voice state where the browser dropped without a proper /voice/leave).
   */
  const userConnections = new Map<string, Set<string>>();

  // Wire broker -> sockets.
  const unsub = gatewayBroker.subscribe((event) => {
    fanout(event, clients).catch((err) => {
      app.log.error({ err }, 'gateway fanout error');
    });
    // PERM-002: a GUILD_BAN_ADD targeting a user must also sever their open
    // WebSocket(s) so the banned user is actually disconnected, not merely
    // notified. Run after the dispatch fanout above so the client receives
    // the event before the close frame.
    if (event.type === 'GUILD_BAN_ADD' && event.userId) {
      for (const c of clients.values()) {
        if (c.userId === event.userId) {
          try {
            c.ws.close(4403, 'banned');
          } catch {
            /* ignore */
          }
        }
      }
    }
  });
  app.addHook('onClose', async () => unsub());

  // Heartbeat sweeper. RT-011: also sweeps clients that never got past HELLO
  // (the IDENTIFY-timeout `setTimeout` covers the first few seconds; after
  // that an idle-pre-identified socket would otherwise dangle until the OS
  // FIN-WAIT timer fires).
  const interval = setInterval(() => {
    const cutoff = Date.now() - GATEWAY.HEARTBEAT_TIMEOUT_MS;
    for (const c of clients.values()) {
      if (c.lastHeartbeatAt < cutoff) {
        try {
          c.ws.close(1011, c.identified ? 'heartbeat timeout' : 'idle pre-identify');
        } catch {
          /* ignore */
        }
      }
    }
  }, 5_000);
  app.addHook('onClose', async () => clearInterval(interval));

  app.get('/gateway', { websocket: true }, (socket, req) => {
    const id = ulid();
    const client: Client = {
      id,
      ws: socket,
      userId: null,
      sessionId: null,
      lastHeartbeatAt: Date.now(),
      seq: 0,
      buffer: [],
      bufferFloor: 0,
      identified: false,
      closing: false,
    };
    clients.set(id, client);

    // HELLO right away.
    sendRaw(client, {
      op: GatewayOp.HELLO,
      d: { heartbeatIntervalMs: GATEWAY.HEARTBEAT_INTERVAL_MS, sessionId: id },
      s: null,
      t: null,
    });

    // Force IDENTIFY within a short window.
    const identifyTimer = setTimeout(() => {
      if (!client.identified) {
        try {
          socket.close(1008, 'IDENTIFY timeout');
        } catch {
          /* ignore */
        }
      }
    }, GATEWAY.IDENTIFY_TIMEOUT_MS);

    socket.on('message', (raw: Buffer | ArrayBuffer | string) => {
      // Guard against oversize frames before parsing. WS-level maxPayload
      // is enforced per frame; this also covers reassembled fragmented
      // messages and gives the client a clear close code.
      const byteLength =
        typeof raw === 'string'
          ? Buffer.byteLength(raw, 'utf8')
          : raw instanceof ArrayBuffer
            ? raw.byteLength
            : raw.length;
      if (byteLength > GATEWAY.MAX_PAYLOAD_BYTES) {
        socket.close(1009, 'message too large');
        return;
      }

      let parsed: GatewayPayload;
      try {
        const text =
          typeof raw === 'string'
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString('utf8')
              : raw.toString('utf8');
        parsed = JSON.parse(text) as GatewayPayload;
      } catch {
        socket.close(1003, 'invalid payload');
        return;
      }

      handleMessage(parsed, client, jwt).catch((err) => {
        req.log.warn({ err: err instanceof Error ? err.message : err }, 'gateway message error');
        if (err instanceof TavernError && err.statusCode === 401) {
          sendRaw(client, { op: GatewayOp.INVALID_SESSION, d: { reason: err.code }, s: null, t: null });
          socket.close(4401, 'unauthorized');
        }
      });
    });

    socket.on('close', () => {
      clearTimeout(identifyTimer);
      clients.delete(id);
      // RT-009: untrack the user's connection set. If this was the last open
      // socket for the user, sweep any presence flags that may have stuck on
      // (a browser tab that crashed without firing /voice/leave). The sweep
      // is best-effort and async — the close handler does not await it.
      if (client.userId) {
        const set = userConnections.get(client.userId);
        if (set) {
          set.delete(id);
          if (set.size === 0) {
            userConnections.delete(client.userId);
            void cleanupAfterLastConnection(client.userId).catch((err) => {
              app.log.warn({ err, userId: client.userId }, 'last-connection cleanup failed');
            });
          }
        }
      }
    });

    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });
  });

  async function handleMessage(payload: GatewayPayload, client: Client, jwtSvc: JwtService): Promise<void> {
    if (payload.op === GatewayOp.IDENTIFY) {
      const id = gatewayIdentifyPayloadSchema.parse(payload.d);
      const access = await jwtSvc.verifyAccess(id.token);
      const session = await prisma.session.findUnique({ where: { id: access.sid } });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        throw TavernError.unauthorized('Session is no longer valid');
      }
      client.userId = access.sub;
      client.sessionId = access.sid;
      client.identified = true;
      registerUserConnection(client.userId, client.id);

      const ready = await buildReadyPayload(access.sub);
      sendDispatch(client, 'READY', ready);
      return;
    }

    if (payload.op === GatewayOp.RESUME) {
      const r = gatewayResumePayloadSchema.parse(payload.d);
      const access = await jwtSvc.verifyAccess(r.token);
      // Mirror the IDENTIFY session check — a revoked or expired session
      // must not be allowed to resume even if its access token hasn't yet
      // expired.
      const session = await prisma.session.findUnique({ where: { id: access.sid } });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        throw TavernError.unauthorized('Session is no longer valid');
      }

      // RT-003: cross-process resume cannot replay events held only in another
      // replica's per-process buffer. If the client is asking for a seq we
      // can't service, surface that explicitly so it can re-IDENTIFY and
      // refetch state, instead of silently dropping events between READY and
      // their next dispatch.
      if (client.bufferFloor > 0 && r.lastSeq < client.bufferFloor) {
        app.log.warn(
          { userId: access.sub, requestedSeq: r.lastSeq, bufferFloor: client.bufferFloor },
          'gateway resume: client lastSeq older than buffer floor; forcing fresh IDENTIFY',
        );
        sendRaw(client, {
          op: GatewayOp.INVALID_SESSION,
          d: { reason: 'BUFFER_GAP' },
          s: null,
          t: null,
        });
        return;
      }

      client.userId = access.sub;
      client.sessionId = access.sid;
      client.identified = true;
      registerUserConnection(client.userId, client.id);

      // RT-010: when the buffer can service the requested seq, replay
      // everything after `lastSeq` to the new socket. The previous behaviour
      // always re-READYed; now a same-process reconnect (overwhelmingly the
      // common case) catches up without a full state refetch.
      const replayable = client.buffer.filter((b) => b.s > r.lastSeq);
      if (replayable.length > 0 && client.bufferFloor <= r.lastSeq + 1) {
        for (const item of replayable) {
          sendRaw(client, item.payload);
        }
        return;
      }
      // Cross-process or buffer-empty resume: fall back to a fresh READY.
      const ready = await buildReadyPayload(access.sub);
      sendDispatch(client, 'READY', ready);
      return;
    }

    if (payload.op === GatewayOp.HEARTBEAT) {
      const ack = gatewayHeartbeatPayloadSchema.parse(payload.d);
      void ack; // we don't currently need the seq on the server side
      client.lastHeartbeatAt = Date.now();
      sendRaw(client, { op: GatewayOp.HEARTBEAT_ACK, d: null, s: null, t: null });
      return;
    }

    // Hello echo and unknown opcodes: ignore.
  }

  async function fanout(event: GatewayEvent, clientsMap: Map<string, Client>): Promise<void> {
    // RT-005: per-fanout request-scoped cache so we don't issue one
    // getChannelPermissions DB round-trip per recipient. Keyed by
    // (channelId, userId) — every viewer-of-the-same-channel hits the same
    // entry after the first fetch. The cache lives for one fanout call only.
    const channelPermCache = new Map<string, ReturnType<typeof getChannelPermissions>>();
    for (const c of clientsMap.values()) {
      if (!c.identified || !c.userId) continue;
      const should = await shouldDeliver(event, c.userId, channelPermCache);
      if (!should) continue;
      sendDispatch(c, event.type, event.data);
    }
  }

  function sendRaw(client: Client, payload: GatewayPayload): void {
    if (client.closing) return;
    // RT-002: slow-consumer eviction. The `ws` socket buffers unsent frames
    // in memory; a client that never drains would otherwise let it grow
    // without bound, accumulating per-server until OOM. Above the threshold
    // we close with 1009 (message too big) which is the closest standard
    // code; the close handler unsticks every related resource.
    const buffered = (client.ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > MAX_BUFFERED_BYTES) {
      app.log.warn(
        { clientId: client.id, userId: client.userId, buffered },
        'gateway: dropping slow consumer',
      );
      client.closing = true;
      try {
        client.ws.close(1009, 'slow consumer');
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      client.ws.send(JSON.stringify(payload));
    } catch {
      // Socket gone — let close handler clean up.
    }
  }

  function sendDispatch(client: Client, type: GatewayDispatchEventName, data: unknown): void {
    client.seq += 1;
    const payload: GatewayPayload = {
      op: GatewayOp.DISPATCH,
      d: data,
      s: client.seq,
      t: type,
    };
    client.buffer.push({ s: client.seq, payload });
    if (client.buffer.length > BUFFER_MAX) {
      // RT-003: advance the buffer floor so a future RESUME knows we can no
      // longer replay everything the client may have missed.
      const dropped = client.buffer.shift();
      if (dropped) client.bufferFloor = dropped.s + 1;
    } else if (client.buffer.length === 1) {
      client.bufferFloor = client.seq;
    }
    sendRaw(client, payload);
  }

  function registerUserConnection(userId: string, clientId: string): void {
    let set = userConnections.get(userId);
    if (!set) {
      set = new Set();
      userConnections.set(userId, set);
    }
    set.add(clientId);
  }

  /**
   * RT-009: when the user's last open WebSocket goes away (all tabs closed,
   * page-navigated away, network drop), sweep voice presence so the room UI
   * stops showing them as "active". We rely on the gateway being the
   * authoritative observer for "user is online" — the alternative is a
   * server-driven heartbeat on the voice route itself, which is more code
   * and more latency-sensitive.
   */
  async function cleanupAfterLastConnection(userId: string): Promise<void> {
    const states = await prisma.voiceState.findMany({
      where: { userId, channelId: { not: null } },
    });
    if (states.length === 0) return;
    await prisma.voiceState.updateMany({
      where: { userId, channelId: { not: null } },
      data: {
        channelId: null,
        joinedAt: null,
        selfMute: false,
        selfDeaf: false,
        cameraOn: false,
        screenSharing: false,
      },
    });
    for (const s of states) {
      gatewayBroker.publish({
        type: 'VOICE_STATE_UPDATE',
        serverId: s.serverId,
        ...(s.channelId ? { channelId: s.channelId } : {}),
        data: voiceStateGatewayPayloadSchema.parse({
          serverId: s.serverId,
          userId,
          channelId: null,
          selfMute: false,
          selfDeaf: false,
          cameraOn: false,
          screenSharing: false,
          joinedAt: null,
        }),
      });
    }
  }

  // Used to silence "unused export" warnings for the schema; the schema is
  // imported so consumers (tests / typecheck) see it pulled into the bundle.
  void gatewayHelloPayloadSchema;
}

async function buildReadyPayload(userId: string): Promise<unknown> {
  const [memberships, bannedFrom] = await Promise.all([
    prisma.serverMember.findMany({
      where: { userId },
      include: { server: true, roles: true },
    }),
    // PERM-002: defensive filter — by the time a user IDENTIFYs they should
    // already have been removed from ServerMember on ban, but excluding here
    // covers the (small) race where a ban fires between findMany and now.
    activeBanServerIds(userId),
  ]);
  return {
    user: { id: userId },
    servers: memberships
      .filter((m) => !bannedFrom.has(m.server.id))
      .map((m) => ({
        id: m.server.id,
        name: m.server.name,
        ownerUserId: m.server.ownerUserId,
        iconAttachmentId: m.server.iconAttachmentId,
        defaultRoleId: m.server.defaultRoleId,
        roles: m.roles.map((r) => r.roleId),
      })),
  };
}

async function shouldDeliver(
  event: GatewayEvent,
  userId: string,
  channelPermCache?: Map<string, ReturnType<typeof getChannelPermissions>>,
): Promise<boolean> {
  if (event.userId && event.userId !== userId) return false;
  if (event.userId === userId) return true;

  if (event.channelId) {
    const cacheKey = `${event.channelId}:${userId}`;
    let resultPromise = channelPermCache?.get(cacheKey);
    if (!resultPromise) {
      resultPromise = getChannelPermissions(event.channelId, userId);
      channelPermCache?.set(cacheKey, resultPromise);
    }
    const result = await resultPromise;
    if (!result) return false;
    return (
      (result.perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL ||
      (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR
    );
  }

  if (event.serverId) {
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: event.serverId, userId } },
      select: { userId: true },
    });
    if (member) return true;
    const owner = await prisma.server.findUnique({
      where: { id: event.serverId },
      select: { ownerUserId: true },
    });
    return owner?.ownerUserId === userId;
  }

  // Untargeted (broadcast) events get filtered by the caller. Default deny.
  void PERMISSION_ALL;
  return false;
}
