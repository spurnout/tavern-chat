/**
 * P4-6 — `POST /api/federation/invites/:code/accept` integration coverage.
 *
 * The route's job: build a signed `member.join_request` envelope, POST it
 * synchronously to the home peer's `_federation/event`, verify the
 * `member.joined` response, and mirror the snapshot locally. The test
 * harness substitutes the real synchronous POST with a deterministic stub
 * via `buildApp`'s `federationSyncDispatchOverride` so we exercise the full
 * server-side flow without booting a second Fastify app for the home.
 *
 * Coverage matrix:
 *   1. Happy path full flow — first-ever accept on this instance: mirror
 *      Server, Roles, Channels, ServerMembers all materialised, and a
 *      `SERVER_ADD` event fires on the gateway broker addressed to the
 *      joiner.
 *   2. Home rejects (404 invalid invite) — error propagates as 404.
 *   3. Home rejects (410 expired) — error propagates as 410 with
 *      INVALID_INVITE.
 *   4. Peer not peered → 403.
 *   5. Idempotent re-accept — same user accepting twice returns 200 the
 *      second time without re-snapshotting.
 *   6. Mirror exists, new user joins — second user accepts; mirror NOT
 *      re-snapshotted, just a new ServerMember.
 *   7. Two-layer signing — the request envelope built by the route carries
 *      both a verifiable user signature AND instance signature.
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
import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
// IMPORTANT: ./setup.js must import BEFORE any module that transitively pulls
// in @tavern/db (which is what builds the Prisma singleton against
// DATABASE_URL). All other test imports follow.
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import {
  ENVELOPE_DEFAULT_LIFETIME_S,
  PROTOCOL_VERSION,
  ulid,
  type MemberJoinRequestPayload,
  type MemberJoinedPayload,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  canonicalize,
  exportPublicKeyRaw,
  generateKeyPair,
  publicKeyFromRaw,
  sign as edSign,
  verify as edVerify,
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
const PEER_HOST = 'a.example'; // A — the home peer that minted the invite

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

/**
 * Seed a local user that will act as the joiner, plus a Session row so the
 * bearer-token flow works. Returns the bearer token + user id for use in
 * `app.inject`.
 */
async function makeJoiner(): Promise<{ userId: string; username: string; token: string }> {
  const userId = ulid();
  const sessionId = ulid();
  const username = `joiner-${userId.slice(-6).toLowerCase()}`;
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

interface BuildSnapshotOpts {
  serverId?: string;
  ownerLocalpart?: string;
  channelIds?: string[];
  memberRemoteUserIds?: string[];
  /** Override `inviteCode` returned in the response (defaults to the input code). */
  inviteCodeOverride?: string;
}

/**
 * Build a fully-signed `member.joined` reply envelope as if the home (A) is
 * the responder. The returned envelope is single-layer, signed by `peerKp`.
 */
function buildJoinedReply(
  peerKp: ReturnType<typeof generateKeyPair>,
  inviteCode: string,
  opts: BuildSnapshotOpts = {},
): SingleLayerSignedEnvelope<MemberJoinedPayload> {
  const serverId = opts.serverId ?? ulid();
  const ownerLocalpart = opts.ownerLocalpart ?? 'alice';
  const channelIds = opts.channelIds ?? [ulid(), ulid()];
  const memberRemoteUserIds =
    opts.memberRemoteUserIds ?? [`${ownerLocalpart}@${PEER_HOST}`];

  const payload: MemberJoinedPayload = {
    inviteCode: opts.inviteCodeOverride ?? inviteCode,
    serverSnapshot: {
      serverId,
      ownerRemoteUserId: `${ownerLocalpart}@${PEER_HOST}`,
      name: 'Federated Tavern',
      description: 'Mirror under test',
      iconUrl: null,
      federationEnabled: true,
      channels: channelIds.map((id, i) => ({
        id,
        name: `general-${i}`,
        type: 'text' as const,
        topic: null,
        position: i,
        federationMode: 'inherit' as const,
        nsfw: false,
      })),
      members: memberRemoteUserIds.map((remoteUserId, i) => ({
        remoteUserId,
        displayName: `Member ${i}`,
        joinedAt: new Date().toISOString(),
      })),
      createdAt: new Date().toISOString(),
    },
  };

  const now = Date.now();
  const notBefore = new Date(now);
  const notAfter = new Date(now + ENVELOPE_DEFAULT_LIFETIME_S * 1000);
  const unsigned = {
    version: PROTOCOL_VERSION,
    eventType: 'member.joined' as const,
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
  } as SingleLayerSignedEnvelope<MemberJoinedPayload>;
}

/**
 * Pre-populate a RemoteUser cache row so the mirror service's resolver
 * doesn't fall through to a real network fetch. Returns the qualified id.
 */
async function seedRemoteUser(opts: {
  peerId: string;
  remoteUserId: string;
  displayName?: string;
}): Promise<void> {
  // Match the schema: 32-byte ed25519 public key + cached display name.
  await prisma.remoteUser.upsert({
    where: { remoteUserId: opts.remoteUserId },
    create: {
      id: ulid(),
      remoteInstanceId: opts.peerId,
      remoteUserId: opts.remoteUserId,
      displayNameCache: opts.displayName ?? opts.remoteUserId,
      avatarUrlCache: null,
      publicKey: randomBytes(32),
    },
    update: {},
  });
}

/**
 * Tear down everything the accept route touches. Order matters: ServerMember
 * cascades on Server delete, but we explicitly clear independent tables to
 * avoid leaving rows around between tests.
 */
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

describe.skipIf(!dockerOk)('POST /api/federation/invites/:code/accept', () => {
  beforeEach(async () => {
    await reset();
  });

  // ─── 1. Happy path full flow ───────────────────────────────────────────────

  it('happy path: mirrors server, channels, members; broadcasts SERVER_ADD to joiner', async () => {
    const { token, userId, username } = await makeJoiner();
    const { peerId, peerKp } = await seedPeer({ host: PEER_HOST });
    const serverId = ulid();
    const channelIds = [ulid(), ulid(), ulid()];
    const ownerRemoteUserId = `alice@${PEER_HOST}`;
    const aliceFriendRemoteUserId = `bob@${PEER_HOST}`;

    // Pre-seed the RemoteUser cache for every member in the snapshot — keeps
    // the resolver on the cache-hit path so the test doesn't need to also
    // mock fetchRemoteProfile.
    await seedRemoteUser({ peerId, remoteUserId: ownerRemoteUserId, displayName: 'Alice' });
    await seedRemoteUser({ peerId, remoteUserId: aliceFriendRemoteUserId, displayName: 'Bob' });

    const sentEnvelopes: TwoLayerSignedEnvelope<MemberJoinRequestPayload>[] = [];
    const dispatch: PostFederationEventSyncFn = async (input) => {
      // Capture for the signing-shape assertion below.
      sentEnvelopes.push(
        input.envelope as TwoLayerSignedEnvelope<MemberJoinRequestPayload>,
      );
      const reply = buildJoinedReply(peerKp, 'INVITE-1', {
        serverId,
        ownerLocalpart: 'alice',
        channelIds,
        memberRemoteUserIds: [ownerRemoteUserId, aliceFriendRemoteUserId],
      });
      return { ok: true, payload: reply.payload as never };
    };

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });

    // Subscribe to the gateway broker so we can assert SERVER_ADD fires.
    const events: Array<{ type: string; userId?: string; data: unknown }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/INVITE-1/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        serverId,
        mirrored: true,
        alreadyMember: false,
      });

      // Mirror Server row — originInstanceId pinned to the peer, federation on.
      const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
      expect(server.originInstanceId).toBe(peerId);
      expect(server.federationEnabled).toBe(true);
      expect(server.name).toBe('Federated Tavern');

      // @everyone role + defaultRoleId.
      expect(server.defaultRoleId).not.toBeNull();
      const role = await prisma.role.findUniqueOrThrow({
        where: { id: server.defaultRoleId! },
      });
      expect(role.isEveryone).toBe(true);

      // Channels — all N upserted.
      const channels = await prisma.channel.findMany({ where: { serverId } });
      expect(channels.map((c) => c.id).sort()).toEqual([...channelIds].sort());
      for (const c of channels) {
        expect(c.originInstanceId).toBe(peerId);
        expect(c.federationMode).toBe('inherit');
      }

      // Members: synthetic owner (from snapshot.members) + the joiner.
      // `addMirrorMember` is idempotent on the owner because createMirrorServer
      // already inserted them, so we end up with three distinct ServerMember
      // rows: alice (synthetic), bob (synthetic), joiner (local).
      const members = await prisma.serverMember.findMany({
        where: { serverId },
        include: { user: { select: { id: true, remoteUserId: true } } },
      });
      const memberRemoteIds = members
        .map((m) => m.user.remoteUserId)
        .sort();
      // The joiner has remoteUserId=null (local user); each remote member
      // appears once.
      expect(memberRemoteIds).toEqual([
        null,
        aliceFriendRemoteUserId,
        ownerRemoteUserId,
      ].sort());
      expect(members.some((m) => m.userId === userId)).toBe(true);

      // Gateway broadcast.
      const serverAdds = events.filter((e) => e.type === 'SERVER_ADD');
      expect(serverAdds.length).toBe(1);
      expect(serverAdds[0]!.userId).toBe(userId);

      // Request envelope shape: two-layer signing.
      expect(sentEnvelopes.length).toBe(1);
      const sent = sentEnvelopes[0]!;
      expect(sent.eventType).toBe('member.join_request');
      expect(sent.fromInstance).toBe(SELF_HOST);
      expect(sent.toInstance).toBe(PEER_HOST);
      expect(sent.payload).toEqual({
        inviteCode: 'INVITE-1',
        joinerRemoteUserId: `${username}@${SELF_HOST}`,
      });
      // Instance signature verifies against B's keypair (we can derive it
      // from the federation key store via the well-known route — but for a
      // tighter assertion, just confirm both sigs are non-empty base64.
      expect(sent.userSignature.length).toBeGreaterThan(0);
      expect(sent.signature.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  // ─── 2. Home rejects with 404 (invalid invite code) ────────────────────────

  it('propagates a 404 from the home as 404 + NOT_FOUND', async () => {
    const { token } = await makeJoiner();
    await seedPeer({ host: PEER_HOST });

    const dispatch: PostFederationEventSyncFn = async () => ({
      ok: false,
      status: 404,
      reason: 'invite not found',
    });

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/UNKNOWN/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');

      // Nothing should have been mirrored.
      const servers = await prisma.server.findMany({});
      expect(servers).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('propagates a 410 from the home as 410 + INVALID_INVITE', async () => {
    const { token } = await makeJoiner();
    await seedPeer({ host: PEER_HOST });

    const dispatch: PostFederationEventSyncFn = async () => ({
      ok: false,
      status: 410,
      reason: 'invite has been revoked',
    });

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/REVOKED/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(res.statusCode).toBe(410);
      const body = res.json();
      expect(body.error.code).toBe('INVALID_INVITE');
    } finally {
      await app.close();
    }
  });

  // ─── 3. Peer not peered → 403 ─────────────────────────────────────────────

  it('rejects with 403 when the remoteInstanceHost is not peered', async () => {
    const { token } = await makeJoiner();
    // No seedPeer call — c.example is unknown.
    const c_HOST = 'c.example';

    // The dispatch override should NEVER be called — the route bails before
    // POSTing anywhere. Use a vi.fn to assert that.
    const dispatch = vi.fn() as unknown as PostFederationEventSyncFn;

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/ANY/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: c_HOST },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects with 403 when the peer exists but status != peered', async () => {
    const { token } = await makeJoiner();
    await seedPeer({ host: PEER_HOST, status: 'revoked' });
    const dispatch = vi.fn() as unknown as PostFederationEventSyncFn;

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/ANY/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(res.statusCode).toBe(403);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ─── 4. Idempotent re-accept ──────────────────────────────────────────────

  it('idempotent re-accept by the same user returns 200 alreadyMember=true the second time', async () => {
    const { token, userId } = await makeJoiner();
    const { peerId, peerKp } = await seedPeer({ host: PEER_HOST });
    const serverId = ulid();
    const channelIds = [ulid()];
    const ownerRemoteUserId = `alice@${PEER_HOST}`;
    await seedRemoteUser({ peerId, remoteUserId: ownerRemoteUserId });

    const dispatch: PostFederationEventSyncFn = async () => {
      const reply = buildJoinedReply(peerKp, 'INVITE-1', {
        serverId,
        ownerLocalpart: 'alice',
        channelIds,
        memberRemoteUserIds: [ownerRemoteUserId],
      });
      return { ok: true, payload: reply.payload as never };
    };

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      // First accept — full flow.
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/INVITE-1/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().data.alreadyMember).toBe(false);

      // After the first accept, the joiner is a member.
      const memberAfterFirst = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId } },
      });
      expect(memberAfterFirst).not.toBeNull();

      // Second accept — same user, same code. The mirror service should
      // NOT re-snapshot; we just confirm `alreadyMember` flips to true.
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/INVITE-1/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(r2.statusCode).toBe(200);
      const body2 = r2.json();
      expect(body2.data.alreadyMember).toBe(true);
      expect(body2.data.serverId).toBe(serverId);

      // Channels did not duplicate.
      const channels = await prisma.channel.findMany({ where: { serverId } });
      expect(channels).toHaveLength(channelIds.length);
    } finally {
      await app.close();
    }
  });

  // ─── 5. Mirror exists, second user accepts ────────────────────────────────

  it('mirror exists, new user accepts: skips re-snapshot, just adds ServerMember', async () => {
    const { token: t1, userId: u1 } = await makeJoiner();
    const { token: t2, userId: u2 } = await makeJoiner();
    const { peerId, peerKp } = await seedPeer({ host: PEER_HOST });
    const serverId = ulid();
    const channelIds = [ulid()];
    const ownerRemoteUserId = `alice@${PEER_HOST}`;
    await seedRemoteUser({ peerId, remoteUserId: ownerRemoteUserId });

    const dispatch: PostFederationEventSyncFn = async () => {
      const reply = buildJoinedReply(peerKp, 'SHARED', {
        serverId,
        ownerLocalpart: 'alice',
        channelIds,
        memberRemoteUserIds: [ownerRemoteUserId],
      });
      return { ok: true, payload: reply.payload as never };
    };

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
    });
    try {
      // First user accepts — full mirror created.
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/SHARED/accept',
        headers: { authorization: `Bearer ${t1}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(r1.statusCode).toBe(200);

      const channelsAfter1 = await prisma.channel.findMany({ where: { serverId } });
      expect(channelsAfter1).toHaveLength(1);

      // Second user accepts — mirror already exists; we should NOT re-create
      // channels or wipe state.
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/SHARED/accept',
        headers: { authorization: `Bearer ${t2}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(r2.statusCode).toBe(200);

      const channelsAfter2 = await prisma.channel.findMany({ where: { serverId } });
      // Same number of channels — no duplicates.
      expect(channelsAfter2.map((c) => c.id).sort()).toEqual(
        channelsAfter1.map((c) => c.id).sort(),
      );

      // Both joiners are members.
      const m1 = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: u1 } },
      });
      const m2 = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: u2 } },
      });
      expect(m1).not.toBeNull();
      expect(m2).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ─── 6. Two-layer signing inspection ──────────────────────────────────────

  it('the outgoing envelope verifies under both the joiner and instance keys', async () => {
    const { token, userId, username } = await makeJoiner();
    const { peerId, peerKp } = await seedPeer({ host: PEER_HOST });
    const serverId = ulid();
    const ownerRemoteUserId = `alice@${PEER_HOST}`;
    await seedRemoteUser({ peerId, remoteUserId: ownerRemoteUserId });

    let capturedEnvelope: TwoLayerSignedEnvelope<MemberJoinRequestPayload> | null = null;
    const dispatch: PostFederationEventSyncFn = async (input) => {
      capturedEnvelope = input.envelope as TwoLayerSignedEnvelope<MemberJoinRequestPayload>;
      const reply = buildJoinedReply(peerKp, 'INVITE-SIG', {
        serverId,
        ownerLocalpart: 'alice',
        channelIds: [ulid()],
        memberRemoteUserIds: [ownerRemoteUserId],
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
        url: '/api/federation/invites/INVITE-SIG/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: { remoteInstanceHost: PEER_HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(capturedEnvelope).not.toBeNull();
      const env = capturedEnvelope!;

      // The user key was provisioned by the route on the joiner row; read it
      // back to verify the user-layer signature.
      const userRow = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { federationKeyPublic: true },
      });
      expect(userRow.federationKeyPublic).not.toBeNull();
      const userPub = publicKeyFromRaw(Buffer.from(userRow.federationKeyPublic!));
      const payloadBytes = Buffer.from(canonicalize(env.payload as unknown), 'utf8');
      const userSig = Buffer.from(env.userSignature, 'base64');
      expect(edVerify(payloadBytes, userSig, userPub)).toBe(true);

      // The instance signature should verify against B's instance public key
      // (which was generated at FederationKeyStore.bootstrap during buildApp).
      const keyRow = await prisma.federationKey.findFirstOrThrow({
        where: { isCurrent: true },
      });
      const instancePub = publicKeyFromRaw(Buffer.from(keyRow.publicKey));
      const { signature, ...unsigned } = env;
      const envelopeBytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
      const instanceSig = Buffer.from(signature, 'base64');
      expect(edVerify(envelopeBytes, instanceSig, instancePub)).toBe(true);

      // Joiner id in the payload uses the local username — sanity check that
      // the route built the qualified id correctly.
      expect(env.payload.joinerRemoteUserId).toBe(`${username}@${SELF_HOST}`);
    } finally {
      await app.close();
    }
  });

  // ─── 7. Validation: missing remoteInstanceHost in body ────────────────────

  it('rejects missing remoteInstanceHost body field with 400', async () => {
    const { token } = await makeJoiner();
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/federation/invites/SOME/accept',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      // The shared error handler renders a Zod failure as VALIDATION_ERROR
      // (400). Confirm we don't accidentally hit the route body with empty
      // input.
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ─── 8. Helper sanity — building a join-request envelope locally ──────────

  it('sync helper accepts a TwoLayerSignedEnvelope input shape', () => {
    // Construct an envelope the same way the route does — proves the helper
    // input type is satisfiable without the api package's middleware.
    const joinerKp = generateKeyPair();
    const bKp = generateKeyPair();
    const env = buildTwoLayerMessageEnvelope({
      eventType: 'member.join_request',
      fromInstance: SELF_HOST,
      toInstance: PEER_HOST,
      payload: { inviteCode: 'X', joinerRemoteUserId: `me@${SELF_HOST}` },
      signUser: (bytes) => edSign(bytes, joinerKp.privateKey),
      signInstance: (bytes) => edSign(bytes, bKp.privateKey),
    });
    expect(env.eventType).toBe('member.join_request');
    expect(env.userSignature.length).toBeGreaterThan(0);
    expect(env.signature.length).toBeGreaterThan(0);
  });
});
