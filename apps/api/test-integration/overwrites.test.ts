/**
 * Integration coverage for the per-channel permission overwrite surface in
 * `apps/api/src/routes/overwrites.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - GET    /api/channels/:id/overwrites
 *       requires VIEW_CHANNEL (missing channel → 404 via requireChannelPermission)
 *   - PUT    /api/channels/:id/overwrites/:targetType/:targetId
 *       requires MANAGE_ROLES + PERM-003 (cannot allow perms actor lacks) +
 *       PERM-005 (target role/user must belong to the channel's server)
 *   - DELETE /api/channels/:id/overwrites/:targetType/:targetId
 *       requires MANAGE_ROLES; missing overwrite → 404
 *
 * Server owner bypasses all gates. A plain @everyone member (without MANAGE_ROLES)
 * can view channel overwrites but cannot write them.
 *
 * Federation is off so no route touches the outbound queue.
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
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';

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
  channelId: string;
}

/**
 * Create a server owned by `ownerId` with an @everyone role + one text channel.
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'OW Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'general' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Directly insert a non-everyone role. */
async function makeRole(
  serverId: string,
  name: string,
  position = 1,
  permissions = 0n,
): Promise<string> {
  const id = ulid();
  await prisma.role.create({
    data: {
      id,
      serverId,
      name,
      isEveryone: false,
      position,
      permissions: new Prisma.Decimal(serializePermissions(permissions)),
    },
  });
  return id;
}

/** Directly insert a permission overwrite (bypasses the API for pre-seeding). */
async function makeOverwrite(
  channelId: string,
  targetType: 'role' | 'user',
  targetId: string,
  allow = 0n,
  deny = 0n,
): Promise<string> {
  const id = ulid();
  await prisma.permissionOverwrite.create({
    data: {
      id,
      channelId,
      targetType,
      targetId,
      allow: new Prisma.Decimal(serializePermissions(allow)),
      deny: new Prisma.Decimal(serializePermissions(deny)),
    },
  });
  return id;
}

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

type OkBody<T> = { ok: true; data: T };

interface OverwriteDto {
  id: string;
  channelId: string;
  targetType: 'role' | 'user';
  targetId: string;
  allow: string;
  deny: string;
}

describe.skipIf(!dockerOk)('overwrite routes (apps/api/src/routes/overwrites.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // FK-safe order: children first.
    await prisma.apiToken.deleteMany({});
    await prisma.auditLogEntry.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ─── GET /api/channels/:id/overwrites ─────────────────────────────────────

  describe('GET /api/channels/:id/overwrites', () => {
    it('server owner lists overwrites for a channel (200) — returns all seeded rows', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId, everyoneId } = await makeServer(ownerId);
      await makeOverwrite(channelId, 'role', everyoneId, 0n, Permission.SEND_MESSAGES);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/overwrites`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<OverwriteDto[]>;
        expect(body.data).toHaveLength(1);
        expect(body.data[0]?.channelId).toBe(channelId);
        expect(body.data[0]?.targetType).toBe('role');
        expect(body.data[0]?.targetId).toBe(everyoneId);
      } finally {
        await app.close();
      }
    });

    it('returns an empty array when no overwrites exist (200)', async () => {
      const ownerId = await makeUser('owner');
      const { channelId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/overwrites`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<OverwriteDto[]>;
        expect(body.data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('a regular member (VIEW_CHANNEL via @everyone) can list overwrites (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, channelId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/overwrites`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('GET .../overwrites is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${ulid()}/overwrites`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('GET .../overwrites is 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${ulid()}/overwrites`,
          headers: { authorization: `Bearer ${token}` },
        });
        // requireChannelPermission with VIEW_CHANNEL throws 404 on unknown channels
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  // ─── PUT /api/channels/:id/overwrites/:targetType/:targetId ───────────────

  describe('PUT /api/channels/:id/overwrites/:targetType/:targetId', () => {
    it('server owner creates a role overwrite (200) — row persisted', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId, everyoneId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const allow = serializePermissions(Permission.SEND_MESSAGES);
        const deny = serializePermissions(0n);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow, deny },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<OverwriteDto>;
        expect(body.data.channelId).toBe(channelId);
        expect(body.data.targetType).toBe('role');
        expect(body.data.targetId).toBe(everyoneId);

        const row = await prisma.permissionOverwrite.findFirst({
          where: { channelId, targetType: 'role', targetId: everyoneId },
        });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    // Regression: PermissionOverwrite.targetId used to carry a hard FK to
    // Role.id (`PermissionOverwrite_role_fkey`), so a USER overwrite — whose
    // targetId is a user id, not a role id — violated the constraint and the
    // route 500'd, leaving per-user channel overwrites broken end-to-end even
    // though the route, the OverwriteTargetType enum, and the zod schema all
    // advertise them. The FK was dropped (targetId is now a discriminated
    // role-or-user reference); user overwrites must persist like role ones.
    it('a user overwrite persists (200 + row) — targetId no longer FK-bound to Role', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, channelId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/user/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow: '0', deny: serializePermissions(Permission.SEND_MESSAGES) },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<OverwriteDto>;
        expect(body.data.targetType).toBe('user');
        expect(body.data.targetId).toBe(memberId);
        expect(body.data.deny).toBe(serializePermissions(Permission.SEND_MESSAGES));

        const row = await prisma.permissionOverwrite.findFirst({
          where: { channelId, targetType: 'user', targetId: memberId },
        });
        expect(row).not.toBeNull();
        expect(row?.deny.toString()).toBe(serializePermissions(Permission.SEND_MESSAGES));
      } finally {
        await app.close();
      }
    });

    it('upserting an existing overwrite updates it rather than creating a duplicate', async () => {
      const ownerId = await makeUser('owner');
      const { channelId, everyoneId } = await makeServer(ownerId);
      // Seed an initial overwrite via the helper.
      await makeOverwrite(channelId, 'role', everyoneId, 0n, Permission.SEND_MESSAGES);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const newAllow = serializePermissions(Permission.VIEW_CHANNEL);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow: newAllow, deny: '0' },
        });
        expect(res.statusCode).toBe(200);
        const rows = await prisma.permissionOverwrite.findMany({
          where: { channelId, targetType: 'role', targetId: everyoneId },
        });
        // Exactly one row (upsert, not insert).
        expect(rows).toHaveLength(1);
        expect(rows[0]?.allow.toString()).toBe(serializePermissions(Permission.VIEW_CHANNEL));
      } finally {
        await app.close();
      }
    });

    it('PUT .../overwrites is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${ulid()}/overwrites/role/${ulid()}`,
          payload: { allow: '0', deny: '0' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('member WITHOUT MANAGE_ROLES cannot write overwrites (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, channelId, everyoneId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow: '0', deny: '0' },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('PERM-003: non-owner with MANAGE_ROLES cannot allow a perm they do not hold (403)', async () => {
      const ownerId = await makeUser('owner');
      const actorId = await makeUser('actor');
      // @everyone gets MANAGE_ROLES but NOT ADMINISTRATOR.
      const { serverId, channelId, everyoneId } = await makeServer(ownerId, Permission.MANAGE_ROLES);
      await addMember(serverId, actorId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(actorId);
        // Attempt to allow ADMINISTRATOR which actor does not hold.
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            allow: serializePermissions(Permission.ADMINISTRATOR),
            deny: '0',
          },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('PERM-005: role not belonging to channel server → 400', async () => {
      const ownerId = await makeUser('owner');
      const { channelId } = await makeServer(ownerId);

      // Create a SECOND server and a role in it.
      const owner2Id = await makeUser('owner2');
      const server2 = await makeServer(owner2Id);
      const foreignRoleId = await makeRole(server2.serverId, 'ForeignRole', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/role/${foreignRoleId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow: '0', deny: '0' },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('PERM-005: user not a member of the channel server → 400', async () => {
      const ownerId = await makeUser('owner');
      const { channelId } = await makeServer(ownerId);
      const outsiderId = await makeUser('outsider');
      // outsiderId is NOT a member of the server.

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/user/${outsiderId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow: '0', deny: '0' },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('PUT .../overwrites is 400 when body is missing required fields', async () => {
      const ownerId = await makeUser('owner');
      const { channelId, everyoneId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: {}, // missing allow and deny → zod validation fails
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('PUT .../overwrites is 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/channels/${ulid()}/overwrites/role/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { allow: '0', deny: '0' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  // ─── DELETE /api/channels/:id/overwrites/:targetType/:targetId ────────────

  describe('DELETE /api/channels/:id/overwrites/:targetType/:targetId', () => {
    it('server owner deletes a role overwrite (200) and the row is gone', async () => {
      const ownerId = await makeUser('owner');
      const { channelId, everyoneId } = await makeServer(ownerId);
      await makeOverwrite(channelId, 'role', everyoneId, 0n, Permission.SEND_MESSAGES);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);

        const row = await prisma.permissionOverwrite.findFirst({
          where: { channelId, targetType: 'role', targetId: everyoneId },
        });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE .../overwrites is 404 when the overwrite does not exist', async () => {
      const ownerId = await makeUser('owner');
      const { channelId, everyoneId } = await makeServer(ownerId);
      // No overwrite seeded.

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('member WITHOUT MANAGE_ROLES cannot delete overwrites (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, channelId, everyoneId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      await makeOverwrite(channelId, 'role', everyoneId, 0n, Permission.SEND_MESSAGES);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/overwrites/role/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        // Overwrite must still exist.
        const row = await prisma.permissionOverwrite.findFirst({
          where: { channelId, targetType: 'role', targetId: everyoneId },
        });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE .../overwrites is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${ulid()}/overwrites/role/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('DELETE .../overwrites is 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${ulid()}/overwrites/role/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});
