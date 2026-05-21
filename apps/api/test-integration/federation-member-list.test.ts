/**
 * PF-6 — Member-list endpoint surfaces remote-user mirror members.
 *
 * Resolves follow-up #9. The original follow-up text from Phase 2 noted that
 * "remote users do not yet appear in Tavern member lists, even if mentioned"
 * and deferred a real fix to Phase 4 (the federated invite + Tavern mirroring
 * flow). Phase 4 in fact completed the work: a remote user becomes a member
 * via a synthetic local `User` row whose `remoteInstanceId` is set, and the
 * existing `GET /api/servers/:id/members` route reads `serverMember` rows
 * blind to whether the joined user is local or remote, so the row falls out
 * of the same query.
 *
 * This test locks that behaviour in against regression: a future change that
 * adds a "skip remote users" filter, or that drops the `User` row entirely
 * for remote members, would fail here.
 *
 * Setup is a single-instance simulation that matches `admin-remote-members.
 * test.ts` — we seed a `RemoteInstance` + cached `RemoteUser` + a synthetic
 * local `User` for the remote member (the Phase-4 mirror code path), add the
 * remote member to a federated Tavern, and call the route as a local member.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
// IMPORTANT: ./setup.js must import BEFORE any module that transitively pulls
// in @tavern/db (whose Prisma singleton reads DATABASE_URL eagerly).
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';

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

async function makeAuthedUser(opts: {
  usernamePrefix?: string;
}): Promise<{ userId: string; username: string; token: string }> {
  const jwt = new JwtService({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 7,
  });
  const userId = ulid();
  const sessionId = ulid();
  const prefix = opts.usernamePrefix ?? 'alice';
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
  const { token } = await jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });
  return { userId, username, token };
}

async function makeFederatedServer(ownerUserId: string): Promise<string> {
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
 * Seed a remote-user member as Phase 4's mirror flow would: a peered
 * `RemoteInstance`, a `RemoteUser` cache row, and a synthetic local `User`
 * row carrying `remoteInstanceId` + `remoteUserId`. Returns the local user
 * id (this is what shows up as `userId` in the members payload).
 */
async function seedRemoteMember(opts: {
  serverId: string;
  localpart?: string;
  displayName?: string;
  presence?: 'online' | 'idle' | 'dnd' | 'offline';
}): Promise<{
  remoteUserId: string;
  localUserId: string;
  displayName: string;
  presence: 'online' | 'idle' | 'dnd' | 'offline';
}> {
  const peerId = ulid();
  const localpart = opts.localpart ?? `bob-${ulid().slice(-6).toLowerCase()}`;
  const displayName = opts.displayName ?? 'Bob from B';
  const presence = opts.presence ?? 'online';
  const remoteUserId = `${localpart}@${PEER_HOST}`;
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host: PEER_HOST,
      instanceKey: randomBytes(32),
      status: 'peered',
      capabilities: ['messages', 'mirror'],
      peeredAt: new Date(),
    },
  });
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: peerId,
      remoteUserId,
      displayNameCache: displayName,
      avatarUrlCache: null,
      publicKey: randomBytes(32),
      lastSeenAt: new Date(),
    },
  });
  const localUserId = ulid();
  const syntheticUsername = `__rem_${localUserId.toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: localUserId,
      username: syntheticUsername,
      usernameLower: syntheticUsername,
      displayName,
      email: `${remoteUserId}.federated.local`,
      emailLower: `${remoteUserId}.federated.local`,
      passwordHash: null,
      remoteUserId,
      remoteInstanceId: peerId,
      presence,
    },
  });
  await prisma.serverMember.create({
    data: { serverId: opts.serverId, userId: localUserId },
  });
  return { remoteUserId, localUserId, displayName, presence };
}

async function wipe(): Promise<void> {
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

describe.skipIf(!dockerOk)(
  'PF-6 / follow-up #9 — GET /api/servers/:id/members surfaces remote members',
  () => {
    beforeEach(async () => {
      await wipe();
    });

    it('returns the remote-user mirror member alongside local members', async () => {
      const alice = await makeAuthedUser({ usernamePrefix: 'alice' });
      const serverId = await makeFederatedServer(alice.userId);
      const bob = await seedRemoteMember({
        serverId,
        localpart: 'bob',
        displayName: 'Bob from B',
        presence: 'online',
      });

      const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/members`,
          headers: { authorization: `Bearer ${alice.token}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        const members = body.data as Array<{
          serverId: string;
          userId: string;
          user: { id: string; displayName: string; username: string; presence: string };
        }>;

        // Both members must appear in the payload — local alice (the owner)
        // and the synthetic mirror user for Bob.
        expect(members).toHaveLength(2);
        const localRow = members.find((m) => m.userId === alice.userId);
        const remoteRow = members.find((m) => m.userId === bob.localUserId);
        expect(localRow).toBeDefined();
        expect(remoteRow).toBeDefined();

        // Remote-user assertions — this is what follow-up #9 is locking in.
        expect(remoteRow!.user.id).toBe(bob.localUserId);
        expect(remoteRow!.user.displayName).toBe(bob.displayName);
        // The synthetic local user's username is `__rem_<ulid>`; we don't
        // pin the exact value, but it must be present (zod default for the
        // memberUserSchema would otherwise reject the payload at parse).
        expect(remoteRow!.user.username).toMatch(/^__rem_/);
        // Presence must come straight from User.presence on the mirror row.
        expect(remoteRow!.user.presence).toBe(bob.presence);

        // The synthetic local User row is genuinely a remote mirror — confirm
        // the row carries the federation pointer fields so a future refactor
        // that swaps to a dedicated remote-member table fails loudly here.
        const mirrorUser = await prisma.user.findUnique({
          where: { id: bob.localUserId },
          select: { remoteInstanceId: true, remoteUserId: true },
        });
        expect(mirrorUser?.remoteInstanceId).not.toBeNull();
        expect(mirrorUser?.remoteUserId).toBe(bob.remoteUserId);
      } finally {
        await app.close();
      }
    });
  },
);
