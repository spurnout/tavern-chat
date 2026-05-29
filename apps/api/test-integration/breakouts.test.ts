/**
 * Integration coverage for breakout-room routes in
 * `apps/api/src/routes/breakouts.ts`.
 *
 * Endpoints covered:
 *   GET  /api/voice/:channelId/breakouts       — list active breakouts
 *   POST /api/voice/:channelId/breakouts       — create breakout groups (201)
 *   POST /api/breakouts/:id/join               — join / get LiveKit token
 *   POST /api/voice/:channelId/breakouts/end-all — end all breakouts
 *
 * Handler check order:
 *
 * GET /api/voice/:channelId/breakouts
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   requireChannelPermission(VIEW_CHANNEL) → 404 (VIEW_CHANNEL uses notFound)
 *   findMany → 200
 *
 * POST /api/voice/:channelId/breakouts
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   createBodySchema.parse(body) → 400
 *   requireChannelPermission(MANAGE_CHANNELS) → 403
 *   updateMany (end prior) + createMany → 201 { groups: [id,...] }
 *
 * POST /api/breakouts/:id/join
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   breakoutGroup lookup → 404 when missing or endedAt set
 *   isAssigned check → 403
 *   LiveKit availability → 503 when unconfigured
 *   signLiveKitToken + update joinedAt → 200
 *
 * POST /api/voice/:channelId/breakouts/end-all
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   requireChannelPermission(MANAGE_CHANNELS) → 403
 *   updateMany → 200
 *
 * Two app variants:
 *   buildTestApp()     — no LiveKit env vars; join returns 503 past membership guard
 *   buildLiveKitApp()  — dummy LiveKit vars; signLiveKitToken signs locally via jose
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  Permission,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  resetDb,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeUser(slug: string): Promise<string> {
  const id = ulid();
  const uname = `${slug}-${id.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username: uname,
      usernameLower: uname,
      displayName: uname,
      email: `${uname}@example.test`,
      emailLower: `${uname}@example.test`,
      passwordHash: 'x',
    },
  });
  return id;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

interface ServerFixture {
  serverId: string;
  everyoneId: string;
}

/**
 * Create a server owned by `ownerId` with an @everyone role.
 * `extraEveryonePerms` is OR-ed on top of `PERMISSION_DEFAULT_EVERYONE`.
 */
async function makeServer(
  ownerId: string,
  extraEveryonePerms = 0n,
): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Breakout Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE | extraEveryonePerms),
      ),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

/**
 * Create a server where @everyone lacks MANAGE_CHANNELS.
 * Used to produce 403 on routes requiring MANAGE_CHANNELS.
 */
async function makeServerNoManage(ownerId: string): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const noManage = PERMISSION_DEFAULT_EVERYONE & ~Permission.MANAGE_CHANNELS;
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'NoManage Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(noManage)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

async function makeVoiceChannel(serverId: string): Promise<string> {
  const id = ulid();
  await prisma.channel.create({
    data: { id, serverId, type: 'voice', name: 'general-voice', videoEnabled: true },
  });
  return id;
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
  } as NodeJS.ProcessEnv;
}

/**
 * Env with dummy LiveKit credentials. signLiveKitToken uses `jose` to sign a
 * HS256 JWT locally — no live LiveKit server is required.
 */
function envWithLiveKit(dbUrl: string): NodeJS.ProcessEnv {
  return {
    ...envFor(dbUrl),
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecretsuperlong12345678901234',
  } as NodeJS.ProcessEnv;
}

async function buildTestApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envFor(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

async function buildLiveKitApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envWithLiveKit(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

type OkBody<T> = { ok: true; data: T };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('breakout routes (apps/api/src/routes/breakouts.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // =========================================================================
  // GET /api/voice/:channelId/breakouts — list active breakouts
  // =========================================================================

  describe('GET /api/voice/:channelId/breakouts — guards', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/voice/${ulid()}/breakouts`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist (VIEW_CHANNEL uses notFound)', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/voice/${ulid()}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the caller is not a server member (VIEW_CHANNEL leaks as 404)', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      await makeUser('outsider'); // user created but not a server member
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeVoiceChannel(serverId);
      // outsiderId is NOT added to the server
      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  describe('GET /api/voice/:channelId/breakouts — happy path', () => {
    it('returns empty array when no active breakouts exist', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<unknown[]>;
        expect(body.ok).toBe(true);
        expect(body.data).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('returns active breakout groups with their members, excludes ended groups', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeVoiceChannel(serverId);

      // Create one active breakout group
      const groupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: groupId,
          parentChannelId: channelId,
          name: 'Group Alpha',
          livekitRoom: `breakout:${groupId}`,
          createdBy: ownerId,
          members: { create: [{ userId: memberId }] },
        },
      });

      // Create one ended breakout group (should be excluded)
      const endedGroupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: endedGroupId,
          parentChannelId: channelId,
          name: 'Ended Group',
          livekitRoom: `breakout:${endedGroupId}`,
          createdBy: ownerId,
          endedAt: new Date(),
          members: { create: [{ userId: ownerId }] },
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{
            id: string;
            name: string;
            parentChannelId: string;
            livekitRoom: string;
            createdBy: string;
            endsAt: string | null;
            members: Array<{ userId: string; joinedAt: string | null }>;
            createdAt: string;
          }>
        >;
        expect(body.ok).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(body.data[0]!.id).toBe(groupId);
        expect(body.data[0]!.name).toBe('Group Alpha');
        expect(body.data[0]!.parentChannelId).toBe(channelId);
        expect(body.data[0]!.createdBy).toBe(ownerId);
        expect(body.data[0]!.members).toHaveLength(1);
        expect(body.data[0]!.members[0]!.userId).toBe(memberId);
      } finally {
        await app.close();
      }
    });

    it('member with VIEW_CHANNEL can also list breakouts', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<unknown[]>;
        expect(body.ok).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/:channelId/breakouts — create breakout groups
  // =========================================================================

  describe('POST /api/voice/:channelId/breakouts — guards', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts`,
          payload: { groups: [{ name: 'G1', memberIds: [ulid()] }] },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body is missing the groups field', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when groups array is empty', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: { groups: [] },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when a group has no memberIds', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: { groups: [{ name: 'Empty', memberIds: [] }] },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: { groups: [{ name: 'G1', memberIds: [memberId] }] },
        });
        // requireChannelPermission with MANAGE_CHANNELS throws notFound when channel missing
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when caller lacks MANAGE_CHANNELS', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const targetId = await makeUser('target');
      // makeServerNoManage strips MANAGE_CHANNELS — owner goes through fine,
      // but a plain member does not
      const { serverId } = await makeServerNoManage(ownerId);
      await addMember(serverId, memberId);
      await addMember(serverId, targetId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: { groups: [{ name: 'Sneaky', memberIds: [targetId] }] },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe('POST /api/voice/:channelId/breakouts — happy path', () => {
    it('owner creates breakout groups (201) and rows are persisted in DB', async () => {
      const ownerId = await makeUser('owner');
      const memberA = await makeUser('memberA');
      const memberB = await makeUser('memberB');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberA);
      await addMember(serverId, memberB);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            groups: [
              { name: 'Alpha Team', memberIds: [memberA] },
              { name: 'Beta Team', memberIds: [memberB] },
            ],
          },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ groups: string[] }>;
        expect(body.ok).toBe(true);
        expect(body.data.groups).toHaveLength(2);

        // DB: two breakout groups exist
        const dbGroups = await prisma.breakoutGroup.findMany({
          where: { parentChannelId: channelId, endedAt: null },
          include: { members: true },
        });
        expect(dbGroups).toHaveLength(2);
        const names = dbGroups.map((g) => g.name).sort();
        expect(names).toEqual(['Alpha Team', 'Beta Team']);

        // Each group has the correct member
        const alpha = dbGroups.find((g) => g.name === 'Alpha Team')!;
        expect(alpha.members).toHaveLength(1);
        expect(alpha.members[0]!.userId).toBe(memberA);
        expect(alpha.livekitRoom).toMatch(/^breakout:/);
        expect(alpha.createdBy).toBe(ownerId);
      } finally {
        await app.close();
      }
    });

    it('creates breakout with optional minutes (endsAt is set)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const before = Date.now();
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            groups: [{ name: 'Timed Group', memberIds: [memberId] }],
            minutes: 10,
          },
        });
        expect(res.statusCode).toBe(201);
        const group = await prisma.breakoutGroup.findFirst({
          where: { parentChannelId: channelId, endedAt: null },
        });
        expect(group).not.toBeNull();
        expect(group!.endsAt).not.toBeNull();
        const endsAtMs = group!.endsAt!.getTime();
        // endsAt should be roughly 10 minutes in the future
        expect(endsAtMs).toBeGreaterThan(before + 9 * 60 * 1000);
        expect(endsAtMs).toBeLessThan(before + 11 * 60 * 1000);
      } finally {
        await app.close();
      }
    });

    it('creating new breakouts ends any prior active breakouts on the same channel', async () => {
      const ownerId = await makeUser('owner');
      const memberA = await makeUser('memberA');
      const memberB = await makeUser('memberB');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberA);
      await addMember(serverId, memberB);
      const channelId = await makeVoiceChannel(serverId);

      // Seed a prior active breakout
      const priorGroupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: priorGroupId,
          parentChannelId: channelId,
          name: 'Old Group',
          livekitRoom: `breakout:${priorGroupId}`,
          createdBy: ownerId,
          members: { create: [{ userId: memberA }] },
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            groups: [{ name: 'New Group', memberIds: [memberB] }],
          },
        });
        expect(res.statusCode).toBe(201);

        // Prior group should now have endedAt set
        const priorGroup = await prisma.breakoutGroup.findUnique({
          where: { id: priorGroupId },
        });
        expect(priorGroup!.endedAt).not.toBeNull();

        // One new active group
        const activeGroups = await prisma.breakoutGroup.findMany({
          where: { parentChannelId: channelId, endedAt: null },
        });
        expect(activeGroups).toHaveLength(1);
        expect(activeGroups[0]!.name).toBe('New Group');
      } finally {
        await app.close();
      }
    });

    it('returned group ids match the DB rows', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts`,
          headers: { authorization: `Bearer ${token}` },
          payload: { groups: [{ name: 'Solo', memberIds: [memberId] }] },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ groups: string[] }>;
        const [returnedId] = body.data.groups;
        expect(returnedId).toBeTruthy();
        const dbGroup = await prisma.breakoutGroup.findUnique({
          where: { id: returnedId },
        });
        expect(dbGroup).not.toBeNull();
        expect(dbGroup!.name).toBe('Solo');
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/breakouts/:id/join — join a breakout room
  // =========================================================================

  describe('POST /api/breakouts/:id/join — guards (LiveKit disabled)', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${ulid()}/join`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the breakout group does not exist', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${ulid()}/join`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the breakout group has already ended', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeVoiceChannel(serverId);
      const groupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: groupId,
          parentChannelId: channelId,
          name: 'Ended',
          livekitRoom: `breakout:${groupId}`,
          createdBy: ownerId,
          endedAt: new Date(),
          members: { create: [{ userId: ownerId }] },
        },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${groupId}/join`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when the caller is not assigned to the breakout group', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      await addMember(serverId, outsiderId);
      const channelId = await makeVoiceChannel(serverId);
      const groupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: groupId,
          parentChannelId: channelId,
          name: 'Private Room',
          livekitRoom: `breakout:${groupId}`,
          createdBy: ownerId,
          members: { create: [{ userId: memberId }] },
        },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${groupId}/join`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('returns 503 when caller is assigned but LiveKit is not configured', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeVoiceChannel(serverId);
      const groupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: groupId,
          parentChannelId: channelId,
          name: 'Room 1',
          livekitRoom: `breakout:${groupId}`,
          createdBy: ownerId,
          members: { create: [{ userId: ownerId }] },
        },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${groupId}/join`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });
  });

  describe('POST /api/breakouts/:id/join — happy path (LiveKit enabled)', () => {
    it('assigned member gets a LiveKit token (200) and joinedAt is updated', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeVoiceChannel(serverId);
      const groupId = ulid();
      const livekitRoom = `breakout:${groupId}`;
      await prisma.breakoutGroup.create({
        data: {
          id: groupId,
          parentChannelId: channelId,
          name: 'Room A',
          livekitRoom,
          createdBy: ownerId,
          members: { create: [{ userId: memberId }] },
        },
      });
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${groupId}/join`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          token: string;
          roomName: string;
          liveKitUrl: string;
          expiresAt: string;
        }>;
        expect(body.ok).toBe(true);
        expect(typeof body.data.token).toBe('string');
        expect(body.data.token.length).toBeGreaterThan(10);
        expect(body.data.roomName).toBe(livekitRoom);
        expect(body.data.liveKitUrl).toBe('ws://localhost:7880');
        expect(body.data.expiresAt).toBeTruthy();

        // joinedAt should now be set on the BreakoutMember row
        const member = await prisma.breakoutMember.findUnique({
          where: { groupId_userId: { groupId, userId: memberId } },
        });
        expect(member).not.toBeNull();
        expect(member!.joinedAt).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('owner assigned to their own group can also join (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeVoiceChannel(serverId);
      const groupId = ulid();
      await prisma.breakoutGroup.create({
        data: {
          id: groupId,
          parentChannelId: channelId,
          name: 'Owner Room',
          livekitRoom: `breakout:${groupId}`,
          createdBy: ownerId,
          members: { create: [{ userId: ownerId }] },
        },
      });
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/breakouts/${groupId}/join`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ token: string }>;
        expect(body.data.token).toBeTruthy();
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/:channelId/breakouts/end-all — end all breakouts
  // =========================================================================

  describe('POST /api/voice/:channelId/breakouts/end-all — guards', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts/end-all`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/breakouts/end-all`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when the caller lacks MANAGE_CHANNELS', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServerNoManage(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts/end-all`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe('POST /api/voice/:channelId/breakouts/end-all — happy path', () => {
    it('owner ends all active breakouts (200) and endedAt is set on each group', async () => {
      const ownerId = await makeUser('owner');
      const memberA = await makeUser('memberA');
      const memberB = await makeUser('memberB');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberA);
      await addMember(serverId, memberB);
      const channelId = await makeVoiceChannel(serverId);

      // Seed two active groups
      const groupIdA = ulid();
      const groupIdB = ulid();
      await prisma.breakoutGroup.createMany({
        data: [
          {
            id: groupIdA,
            parentChannelId: channelId,
            name: 'Room A',
            livekitRoom: `breakout:${groupIdA}`,
            createdBy: ownerId,
          },
          {
            id: groupIdB,
            parentChannelId: channelId,
            name: 'Room B',
            livekitRoom: `breakout:${groupIdB}`,
            createdBy: ownerId,
          },
        ],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts/end-all`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        // Both groups should now have endedAt set
        const groups = await prisma.breakoutGroup.findMany({
          where: { parentChannelId: channelId },
        });
        expect(groups).toHaveLength(2);
        expect(groups.every((g) => g.endedAt !== null)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('end-all is idempotent when no active breakouts exist (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${channelId}/breakouts/end-all`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('end-all only ends breakouts on the target channel, not other channels', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelA = await makeVoiceChannel(serverId);
      const channelB = await makeVoiceChannel(serverId);

      const groupA = ulid();
      const groupB = ulid();
      await prisma.breakoutGroup.createMany({
        data: [
          {
            id: groupA,
            parentChannelId: channelA,
            name: 'A Room',
            livekitRoom: `breakout:${groupA}`,
            createdBy: ownerId,
          },
          {
            id: groupB,
            parentChannelId: channelB,
            name: 'B Room',
            livekitRoom: `breakout:${groupB}`,
            createdBy: ownerId,
          },
        ],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        await app.inject({
          method: 'POST',
          url: `/api/voice/${channelA}/breakouts/end-all`,
          headers: { authorization: `Bearer ${token}` },
        });

        const groupARow = await prisma.breakoutGroup.findUnique({ where: { id: groupA } });
        const groupBRow = await prisma.breakoutGroup.findUnique({ where: { id: groupB } });
        expect(groupARow!.endedAt).not.toBeNull();
        expect(groupBRow!.endedAt).toBeNull();
      } finally {
        await app.close();
      }
    });
  });
});
