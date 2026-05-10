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
}

const BUFFER_MAX = 256;

export function registerGateway(app: FastifyInstance, jwt: JwtService): void {
  const clients = new Map<string, Client>();

  // Wire broker -> sockets.
  const unsub = gatewayBroker.subscribe((event) => {
    fanout(event, clients).catch((err) => {
      app.log.error({ err }, 'gateway fanout error');
    });
  });
  app.addHook('onClose', async () => unsub());

  // Heartbeat sweeper.
  const interval = setInterval(() => {
    const cutoff = Date.now() - GATEWAY.HEARTBEAT_TIMEOUT_MS;
    for (const c of clients.values()) {
      if (!c.identified) continue;
      if (c.lastHeartbeatAt < cutoff) {
        try {
          c.ws.close(1011, 'heartbeat timeout');
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

      const ready = await buildReadyPayload(access.sub);
      sendDispatch(client, 'READY', ready);
      return;
    }

    if (payload.op === GatewayOp.RESUME) {
      const r = gatewayResumePayloadSchema.parse(payload.d);
      const access = await jwtSvc.verifyAccess(r.token);
      client.userId = access.sub;
      client.sessionId = access.sid;
      client.identified = true;

      // Phase 1 limitation: per-process buffer means cross-process resume is
      // unreliable. We always re-ready clients on resume.
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
    for (const c of clientsMap.values()) {
      if (!c.identified || !c.userId) continue;
      const should = await shouldDeliver(event, c.userId);
      if (!should) continue;
      sendDispatch(c, event.type, event.data);
    }
  }

  function sendRaw(client: Client, payload: GatewayPayload): void {
    if (client.closing) return;
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
    if (client.buffer.length > BUFFER_MAX) client.buffer.shift();
    sendRaw(client, payload);
  }

  // Used to silence "unused export" warnings for the schema; the schema is
  // imported so consumers (tests / typecheck) see it pulled into the bundle.
  void gatewayHelloPayloadSchema;
}

async function buildReadyPayload(userId: string): Promise<unknown> {
  const memberships = await prisma.serverMember.findMany({
    where: { userId },
    include: {
      server: true,
      roles: true,
    },
  });
  return {
    user: { id: userId },
    servers: memberships.map((m) => ({
      id: m.server.id,
      name: m.server.name,
      ownerUserId: m.server.ownerUserId,
      iconAttachmentId: m.server.iconAttachmentId,
      defaultRoleId: m.server.defaultRoleId,
      roles: m.roles.map((r) => r.roleId),
    })),
  };
}

async function shouldDeliver(event: GatewayEvent, userId: string): Promise<boolean> {
  if (event.userId && event.userId !== userId) return false;
  if (event.userId === userId) return true;

  if (event.channelId) {
    const result = await getChannelPermissions(event.channelId, userId);
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
