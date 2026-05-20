/**
 * P3-12: Admin "manual remote member add" endpoint.
 *
 *   POST /api/admin/servers/:id/remote-members  { remoteUserId: "alice@b.example" }
 *
 * The route is the Phase-3 testing backdoor — instance admins paste a
 * qualified remote id and the user becomes a ServerMember of the target
 * server. Phase 4's invite flow will replace it, but until then it's what
 * lets us drive end-to-end fan-out tests.
 *
 * Coverage matrix:
 *   1. Happy path → 201, ServerMember + User row persisted.
 *   2. Unknown peer (host not in RemoteInstance / not peered) → 404.
 *   3. Non-admin user → 403.
 *   4. Server not found → 404.
 *   5. Idempotent re-add → 200, alreadyMember:true.
 *
 * The cached-RemoteUser fixture means `fetchRemoteProfile` returns the
 * cached row without hitting the network (CACHE_TTL_MS = 1 hour in
 * federation-profile.ts — a `lastSeenAt: new Date()` row is always fresh).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';

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

const SELF_HOST = 'self.example';
const PEER_HOST = 'b.example';

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
 * Helper: create a user + session, return a bearer token signed with the same
 * secrets envFor() will set in the API process. Mirrors federation-peering.test.ts.
 */
async function makeAuthedUser(opts: { isInstanceAdmin: boolean }): Promise<{
  userId: string;
  token: string;
}> {
  const jwt = new JwtService({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 7,
  });
  const userId = ulid();
  const sessionId = ulid();
  const username = `user-${userId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@example.com`,
      emailLower: `${username}@example.com`,
      passwordHash: 'x',
      isInstanceAdmin: opts.isInstanceAdmin,
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
  const { token } = await jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });
  return { userId, token };
}

/**
 * Helper: create a server owned by `ownerUserId` with an @everyone role and
 * the owner as a ServerMember. Returns the server id.
 */
async function makeServer(ownerUserId: string): Promise<string> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId,
      name: 'Federated Tavern',
      federationEnabled: true,
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
  await prisma.serverMember.create({ data: { serverId, userId: ownerUserId } });
  return serverId;
}

/**
 * Seed a peered RemoteInstance + a fresh-cached RemoteUser so fetchRemoteProfile
 * returns synchronously from cache without touching the network.
 */
async function seedPeerWithCachedUser(opts: {
  host?: string;
  localpart?: string;
  peerStatus?: 'peered' | 'revoked';
}): Promise<{ remoteUserId: string; peerId: string; userPublicKey: Buffer }> {
  const host = opts.host ?? PEER_HOST;
  const localpart = opts.localpart ?? `alice-${ulid().slice(-6).toLowerCase()}`;
  const peerId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host,
      instanceKey: randomBytes(32),
      status: opts.peerStatus ?? 'peered',
      capabilities: ['messages'],
      peeredAt: new Date(),
    },
  });
  const userPublicKey = randomBytes(32);
  const remoteUserId = `${localpart}@${host}`;
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: peerId,
      remoteUserId,
      displayNameCache: 'Alice from B',
      avatarUrlCache: null,
      publicKey: userPublicKey,
      lastSeenAt: new Date(), // fresh → fetchRemoteProfile short-circuits to cache
    },
  });
  return { remoteUserId, peerId, userPublicKey };
}

async function wipe(): Promise<void> {
  // Tables that reference User/Server cascade; explicit wipe order keeps
  // failures readable on FK-violation regressions.
  await prisma.serverMember.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.federationKey.deleteMany({});
}

describe.skipIf(!dockerOk)('POST /api/admin/servers/:id/remote-members (P3-12)', () => {
  beforeEach(async () => {
    await wipe();
  });

  it('happy path: instance admin adds a cached remote user as a ServerMember (201)', async () => {
    const admin = await makeAuthedUser({ isInstanceAdmin: true });
    const serverId = await makeServer(admin.userId);
    const { remoteUserId } = await seedPeerWithCachedUser({});

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${serverId}/remote-members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { remoteUserId },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.member.serverId).toBe(serverId);
      expect(body.data.member.remoteUserId).toBe(remoteUserId);

      // A synthetic User row should exist for the remote user.
      const user = await prisma.user.findUnique({ where: { remoteUserId } });
      expect(user).not.toBeNull();
      expect(user?.passwordHash).toBeNull();
      expect(user?.id).toBe(body.data.member.userId);

      // The ServerMember row was created.
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: user!.id } },
      });
      expect(member).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('unknown peer (no RemoteInstance for host) → 404', async () => {
    const admin = await makeAuthedUser({ isInstanceAdmin: true });
    const serverId = await makeServer(admin.userId);
    // No RemoteInstance row → fetchRemoteProfile throws
    //   "host nowhere.example is not a peered remote instance"
    // which the route maps to 404.

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${serverId}/remote-members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { remoteUserId: 'ghost@nowhere.example' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/unknown peer/i);
    } finally {
      await app.close();
    }
  });

  it('peer exists but status != peered (e.g. revoked) → 404', async () => {
    const admin = await makeAuthedUser({ isInstanceAdmin: true });
    const serverId = await makeServer(admin.userId);
    // Seed a non-peered instance with no RemoteUser cached — fetchRemoteProfile
    // refuses before it ever consults the cache or the network.
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: 'revoked.example',
        instanceKey: randomBytes(32),
        status: 'revoked',
        capabilities: ['messages'],
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${serverId}/remote-members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { remoteUserId: 'alice@revoked.example' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('non-admin user is rejected with 403', async () => {
    const admin = await makeAuthedUser({ isInstanceAdmin: true });
    const peasant = await makeAuthedUser({ isInstanceAdmin: false });
    const serverId = await makeServer(admin.userId);
    const { remoteUserId } = await seedPeerWithCachedUser({});

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${serverId}/remote-members`,
        headers: { authorization: `Bearer ${peasant.token}` },
        payload: { remoteUserId },
      });
      expect(res.statusCode).toBe(403);
      // No side effects — the user was never materialised.
      expect(await prisma.user.findUnique({ where: { remoteUserId } })).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('server not found → 404', async () => {
    const admin = await makeAuthedUser({ isInstanceAdmin: true });
    const { remoteUserId } = await seedPeerWithCachedUser({});
    const nonexistentServerId = ulid(); // valid ULID shape but not in the table

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${nonexistentServerId}/remote-members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { remoteUserId },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('idempotent: re-adding the same remote user returns 200 with alreadyMember:true', async () => {
    const admin = await makeAuthedUser({ isInstanceAdmin: true });
    const serverId = await makeServer(admin.userId);
    const { remoteUserId } = await seedPeerWithCachedUser({});

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const first = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${serverId}/remote-members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { remoteUserId },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/api/admin/servers/${serverId}/remote-members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { remoteUserId },
      });
      expect(second.statusCode).toBe(200);
      const body = second.json();
      expect(body.data.alreadyMember).toBe(true);
      expect(body.data.member.remoteUserId).toBe(remoteUserId);
    } finally {
      await app.close();
    }
  });
});
