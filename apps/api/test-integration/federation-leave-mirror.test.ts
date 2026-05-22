/**
 * P4-12 — `POST /api/federation/mirror-servers/:serverId/leave` integration
 * coverage.
 *
 * The route builds a signed `member.leave` envelope, POSTs it synchronously
 * to the origin peer (the mirror's home), verifies the `member.removed` ack,
 * and ONLY THEN deletes the local ServerMember + optionally tears the mirror
 * down. The harness substitutes the real synchronous POST with a
 * deterministic stub via `buildApp`'s `federationSyncDispatchOverride` so we
 * can exercise the full server-side flow without booting a second Fastify
 * app to play the home (A).
 *
 * Coverage matrix:
 *   1. Happy path, last local member → mirror torn down, SERVER_REMOVE
 *      broadcast addressed to the leaver.
 *   2. Happy path, other local members remain → mirror preserved,
 *      MEMBER_REMOVE broadcast scoped to the mirror.
 *   3. Server is NOT a mirror (originInstanceId is null) → 404.
 *   4. Caller is not a member → 404.
 *   5. Home returns a 4xx → status propagates, local state unchanged.
 *   6. Outgoing envelope shape — two-layer signed, payload matches the
 *      schema, fromInstance=B, toInstance=A.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
// IMPORTANT: ./setup.js must import BEFORE any module that transitively pulls
// in @tavern/db (which is what builds the Prisma singleton against
// DATABASE_URL). All other test imports follow.
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
import {
  ENVELOPE_DEFAULT_LIFETIME_S,
  PERMISSION_DEFAULT_EVERYONE,
  PROTOCOL_VERSION,
  serializePermissions,
  ulid,
  type MemberLeavePayload,
  type MemberRemovedPayload,
} from '@tavern/shared';
import {
  canonicalize,
  exportPublicKeyRaw,
  generateKeyPair,
  sign as edSign,
  type PostFederationEventSyncFn,
  type SingleLayerSignedEnvelope,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';
import { gatewayBroker } from '../src/services/gateway-broker.js';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

const SELF_HOST = 'b.example'; // B — the receiving instance under test
const PEER_HOST = 'a.example'; // A — the home peer that owns the mirror

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

/**
 * Seed a local user that will act as the leaver, plus a Session row so the
 * bearer-token flow works. Returns the bearer token + user id for use in
 * `app.inject`.
 */
async function makeLeaver(opts?: { usernamePrefix?: string }): Promise<{
  userId: string;
  username: string;
  token: string;
}> {
  const userId = ulid();
  const sessionId = ulid();
  const prefix = opts?.usernamePrefix ?? 'leaver';
  const username = `${prefix}-${userId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@example.com`,
      emailLower: `${username}@example.com`,
      passwordHash: 'x',
    },
  });
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const jwt = new JwtService({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 7,
  });
  const { token } = await jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });
  return { userId, username, token };
}

interface PeerSeed {
  peerId: string;
  peerKp: ReturnType<typeof generateKeyPair>;
}

/**
 * Create a peered RemoteInstance for `host` and return both the row id and
 * the keypair the test harness should use to sign mock response envelopes.
 */
async function seedPeer(opts: {
  host: string;
  status?: 'peered' | 'revoked' | 'pending_inbound' | 'pending_outbound' | 'blocked';
}): Promise<PeerSeed> {
  const peerKp = generateKeyPair();
  const peerId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host: opts.host,
      instanceKey: exportPublicKeyRaw(peerKp.publicKey),
      status: opts.status ?? 'peered',
      capabilities: ['messages', 'mirror'],
      peeredAt: opts.status === 'peered' || opts.status === undefined ? new Date() : null,
    },
  });
  return { peerId, peerKp };
}

interface MirrorSeed {
  serverId: string;
  ownerLocalUserId: string;
  channelId: string;
}

/**
 * Seed a mirror Server owned by a synthetic remote user (the home's owner),
 * with a single mirrored channel. Mirrors are created with
 * `originInstanceId` set; the @everyone role + defaultRoleId follow the
 * same shape `FederationMirrorService.createMirrorServer` produces.
 *
 * The local Users that will become ServerMembers are NOT seeded here — the
 * tests add them explicitly via `addLocalMember` so each test can choose
 * whether the leaver is the last local member or one of several.
 */
async function seedMirror(peer: PeerSeed): Promise<MirrorSeed> {
  // Synthetic owner — the home's owner appears on B as a `User.remoteUserId
  // = alice@a.example` row.
  const ownerLocalUserId = ulid();
  const ownerLocalpart = `alice-${ownerLocalUserId.slice(-6).toLowerCase()}`;
  const ownerRemoteUserId = `${ownerLocalpart}@${PEER_HOST}`;
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: peer.peerId,
      remoteUserId: ownerRemoteUserId,
      displayNameCache: 'Alice',
      avatarUrlCache: null,
      publicKey: randomBytes(32),
    },
  });
  await prisma.user.create({
    data: {
      id: ownerLocalUserId,
      username: `__rem_${ownerLocalUserId.toLowerCase()}`,
      usernameLower: `__rem_${ownerLocalUserId.toLowerCase()}`,
      displayName: 'Alice',
      email: `${ownerRemoteUserId}.federated.local`,
      emailLower: `${ownerRemoteUserId}.federated.local`,
      passwordHash: null,
      remoteUserId: ownerRemoteUserId,
      remoteInstanceId: peer.peerId,
    },
  });

  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: ownerLocalUserId,
      name: 'Federated Tavern',
      federationEnabled: true,
      originInstanceId: peer.peerId,
    },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: {
      id: channelId,
      serverId,
      type: 'text',
      name: 'general',
      federationMode: 'inherit',
      originInstanceId: peer.peerId,
    },
  });
  // Owner is also a member on the mirror (mirrors the createMirrorServer
  // shape — see federation-mirror.ts).
  await prisma.serverMember.create({
    data: { serverId, userId: ownerLocalUserId },
  });
  return { serverId, ownerLocalUserId, channelId };
}

async function addLocalMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/**
 * Build a single-layer signed `member.removed` ack envelope as A would
 * return it. Used by the dispatch stub to simulate the home's response.
 */
function buildMemberRemovedReply(
  peerKp: ReturnType<typeof generateKeyPair>,
  payload: MemberRemovedPayload,
): SingleLayerSignedEnvelope<MemberRemovedPayload> {
  const now = Date.now();
  const notBefore = new Date(now);
  const notAfter = new Date(now + ENVELOPE_DEFAULT_LIFETIME_S * 1000);
  const unsigned = {
    version: PROTOCOL_VERSION,
    eventType: 'member.removed' as const,
    nonce: ulid(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fromInstance: PEER_HOST,
    toInstance: SELF_HOST,
    payload,
  };
  const sigBytes = edSign(
    Buffer.from(canonicalize(unsigned as unknown), 'utf8'),
    peerKp.privateKey,
  );
  return {
    ...unsigned,
    signature: sigBytes.toString('base64'),
  } as SingleLayerSignedEnvelope<MemberRemovedPayload>;
}

async function reset(): Promise<void> {
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  await prisma.federationKey.deleteMany({});
  vi.restoreAllMocks();
}

describe.skipIf(!dockerOk)('POST /api/federation/mirror-servers/:serverId/leave', () => {
  beforeEach(async () => {
    await reset();
  });

  // ─── 1. Happy path — last local member ─────────────────────────────────────

  it('happy path (last local member): tears down mirror + broadcasts SERVER_REMOVE', async () => {
    const peer = await seedPeer({ host: PEER_HOST });
    const mirror = await seedMirror(peer);
    const { token, userId } = await makeLeaver();
    await addLocalMember(mirror.serverId, userId);

    const capturedEnvelopes: TwoLayerSignedEnvelope<MemberLeavePayload>[] = [];
    const dispatch: PostFederationEventSyncFn = async (input) => {
      capturedEnvelopes.push(
        input.envelope as TwoLayerSignedEnvelope<MemberLeavePayload>,
      );
      const env = input.envelope as TwoLayerSignedEnvelope<MemberLeavePayload>;
      const reply = buildMemberRemovedReply(peer.peerKp, {
        serverId: env.payload.serverId,
        leaverRemoteUserId: env.payload.leaverRemoteUserId,
      });
      return { ok: true, payload: reply.payload as never };
    };

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });

    const events: Array<{ type: string; userId?: string; serverId?: string; data: unknown }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${mirror.serverId}/leave`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        serverId: mirror.serverId,
        mirrorTornDown: true,
      });

      // Mirror Server is gone.
      const server = await prisma.server.findUnique({
        where: { id: mirror.serverId },
      });
      expect(server).toBeNull();

      // The leaver's ServerMember row is gone (cascade via Server delete).
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: mirror.serverId, userId } },
      });
      expect(member).toBeNull();

      // Channel + Role cascade as well.
      const channel = await prisma.channel.findUnique({
        where: { id: mirror.channelId },
      });
      expect(channel).toBeNull();

      // SERVER_REMOVE broadcast — addressed to the leaver only.
      const serverRemoves = events.filter((e) => e.type === 'SERVER_REMOVE');
      expect(serverRemoves).toHaveLength(1);
      expect(serverRemoves[0]!.userId).toBe(userId);
      expect((serverRemoves[0]!.data as { serverId: string }).serverId).toBe(
        mirror.serverId,
      );

      // Outgoing envelope was dispatched once.
      expect(capturedEnvelopes).toHaveLength(1);
      expect(capturedEnvelopes[0]!.eventType).toBe('member.leave');
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  // ─── 2. Happy path — other local members remain ────────────────────────────

  it('happy path (other members remain): preserves mirror + broadcasts MEMBER_REMOVE', async () => {
    const peer = await seedPeer({ host: PEER_HOST });
    const mirror = await seedMirror(peer);
    const { token: leaverToken, userId: leaverId } = await makeLeaver({
      usernamePrefix: 'leaver',
    });
    const { userId: stayerId } = await makeLeaver({ usernamePrefix: 'stayer' });
    await addLocalMember(mirror.serverId, leaverId);
    await addLocalMember(mirror.serverId, stayerId);

    const dispatch: PostFederationEventSyncFn = async (input) => {
      const env = input.envelope as TwoLayerSignedEnvelope<MemberLeavePayload>;
      const reply = buildMemberRemovedReply(peer.peerKp, {
        serverId: env.payload.serverId,
        leaverRemoteUserId: env.payload.leaverRemoteUserId,
      });
      return { ok: true, payload: reply.payload as never };
    };

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });

    const events: Array<{ type: string; userId?: string; serverId?: string; data: unknown }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${mirror.serverId}/leave`,
        headers: { authorization: `Bearer ${leaverToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toMatchObject({
        serverId: mirror.serverId,
        mirrorTornDown: false,
      });

      // Mirror is intact.
      const server = await prisma.server.findUnique({
        where: { id: mirror.serverId },
      });
      expect(server).not.toBeNull();
      expect(server!.originInstanceId).toBe(peer.peerId);

      // Leaver's ServerMember row is gone, stayer's row is intact.
      const leaverMember = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: mirror.serverId, userId: leaverId } },
      });
      expect(leaverMember).toBeNull();
      const stayerMember = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: mirror.serverId, userId: stayerId } },
      });
      expect(stayerMember).not.toBeNull();

      // MEMBER_REMOVE broadcast — scoped to the mirror, not user-targeted.
      const memberRemoves = events.filter((e) => e.type === 'MEMBER_REMOVE');
      expect(memberRemoves).toHaveLength(1);
      expect(memberRemoves[0]!.serverId).toBe(mirror.serverId);
      expect(memberRemoves[0]!.userId).toBeUndefined();
      expect((memberRemoves[0]!.data as { userId: string }).userId).toBe(leaverId);

      // No SERVER_REMOVE (the mirror wasn't torn down).
      const serverRemoves = events.filter((e) => e.type === 'SERVER_REMOVE');
      expect(serverRemoves).toHaveLength(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  // ─── 3. Not a mirror server ────────────────────────────────────────────────

  it('returns 404 when the server is not a mirror (originInstanceId is null)', async () => {
    const { token, userId } = await makeLeaver();
    // Local server, no originInstanceId — leaving here doesn't go through
    // the federation route.
    const serverId = ulid();
    const everyoneRoleId = ulid();
    await prisma.server.create({
      data: {
        id: serverId,
        ownerUserId: userId,
        name: 'Local Tavern',
        federationEnabled: false,
      },
    });
    await prisma.role.create({
      data: {
        id: everyoneRoleId,
        serverId,
        name: '@everyone',
        isEveryone: true,
        permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
      },
    });
    await prisma.server.update({
      where: { id: serverId },
      data: { defaultRoleId: everyoneRoleId },
    });
    await prisma.serverMember.create({ data: { serverId, userId } });

    const dispatch = vi.fn() as unknown as PostFederationEventSyncFn;
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${serverId}/leave`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
      // The dispatch override should NEVER fire — the route bails before
      // POSTing anywhere.
      expect(dispatch).not.toHaveBeenCalled();
      // Local member row is untouched.
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId } },
      });
      expect(member).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ─── 4. Not a member of the mirror ────────────────────────────────────────

  it('returns 404 when the caller is not a member of the mirror', async () => {
    const peer = await seedPeer({ host: PEER_HOST });
    const mirror = await seedMirror(peer);
    const { token } = await makeLeaver();
    // Deliberately NOT adding the leaver as a member.

    const dispatch = vi.fn() as unknown as PostFederationEventSyncFn;
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${mirror.serverId}/leave`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ─── 5. Home returns 4xx → route propagates ───────────────────────────────

  it('propagates a 404 from the home as 404 + NOT_FOUND; local state untouched', async () => {
    const peer = await seedPeer({ host: PEER_HOST });
    const mirror = await seedMirror(peer);
    const { token, userId } = await makeLeaver();
    await addLocalMember(mirror.serverId, userId);

    const dispatch: PostFederationEventSyncFn = async () => ({
      ok: false,
      status: 404,
      reason: 'no local User row for someone@b.example',
    });

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${mirror.serverId}/leave`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');

      // Local ServerMember is STILL present (the route refused to mutate).
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: mirror.serverId, userId } },
      });
      expect(member).not.toBeNull();

      // Mirror is intact.
      const server = await prisma.server.findUnique({
        where: { id: mirror.serverId },
      });
      expect(server).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('propagates a 401 from the home as 401 + UNAUTHORIZED', async () => {
    const peer = await seedPeer({ host: PEER_HOST });
    const mirror = await seedMirror(peer);
    const { token, userId } = await makeLeaver();
    await addLocalMember(mirror.serverId, userId);

    const dispatch: PostFederationEventSyncFn = async () => ({
      ok: false,
      status: 401,
      reason: 'leaverRemoteUserId does not match verified user',
    });

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${mirror.serverId}/leave`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');

      // Local state untouched.
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: mirror.serverId, userId } },
      });
      expect(member).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ─── 6. Outgoing envelope shape ────────────────────────────────────────────

  it('the outgoing envelope is two-layer signed with the correct payload shape', async () => {
    const peer = await seedPeer({ host: PEER_HOST });
    const mirror = await seedMirror(peer);
    const { token, userId, username } = await makeLeaver();
    await addLocalMember(mirror.serverId, userId);

    let captured: TwoLayerSignedEnvelope<MemberLeavePayload> | null = null;
    const dispatch: PostFederationEventSyncFn = async (input) => {
      captured = input.envelope as TwoLayerSignedEnvelope<MemberLeavePayload>;
      const reply = buildMemberRemovedReply(peer.peerKp, {
        serverId: mirror.serverId,
        leaverRemoteUserId: `${username}@${SELF_HOST}`,
      });
      return { ok: true, payload: reply.payload as never };
    };

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${mirror.serverId}/leave`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(captured).not.toBeNull();
      const env = captured!;
      expect(env.eventType).toBe('member.leave');
      expect(env.fromInstance).toBe(SELF_HOST);
      expect(env.toInstance).toBe(PEER_HOST);
      expect(env.payload.serverId).toBe(mirror.serverId);
      expect(env.payload.leaverRemoteUserId).toBe(`${username}@${SELF_HOST}`);
      expect(typeof env.payload.leftAt).toBe('string');
      // Both signatures present.
      expect(env.userSignature.length).toBeGreaterThan(0);
      expect(env.signature.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
