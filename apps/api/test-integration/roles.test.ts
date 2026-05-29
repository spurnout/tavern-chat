/**
 * Integration coverage for the server-scoped role management surface in
 * `apps/api/src/routes/roles.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - POST /api/servers/:serverId/roles       — requires MANAGE_ROLES; hierarchy gate
 *   - PATCH /api/roles/:id                   — requires MANAGE_ROLES; hierarchy gate
 *   - DELETE /api/roles/:id                  — requires MANAGE_ROLES; @everyone → 400
 *   - PUT /api/servers/:serverId/members/:userId/roles — requires MANAGE_ROLES; hierarchy gate
 *
 * The server OWNER bypasses all permission + hierarchy gates because
 * `requireServerPermission` / `requireRoleHierarchy` treat owners as
 * PERMISSION_ALL with maxRolePosition = +Infinity.
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
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset so tests can
 * grant MANAGE_ROLES (or any other bit) to every member.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Role Tavern' } });
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

/**
 * Directly insert a non-everyone role into a server (bypasses the API).
 * Returns the new role id.
 */
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

describe.skipIf(!dockerOk)('role routes (apps/api/src/routes/roles.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // FK-safe order: children first, then parents.
    await prisma.apiToken.deleteMany({});
    await prisma.auditLogEntry.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ─── POST /api/servers/:serverId/roles ────────────────────────────────────

  describe('POST /api/servers/:serverId/roles', () => {
    it('server owner creates a role (201) — row persists with correct fields', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Moderator', color: 0xff0000, mentionable: true, hoist: true },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{
          id: string;
          serverId: string;
          name: string;
          color: number;
          mentionable: boolean;
          hoist: boolean;
          isEveryone: boolean;
          permissions: string;
        }>;
        expect(body.data.serverId).toBe(serverId);
        expect(body.data.name).toBe('Moderator');
        expect(body.data.color).toBe(0xff0000);
        expect(body.data.mentionable).toBe(true);
        expect(body.data.hoist).toBe(true);
        expect(body.data.isEveryone).toBe(false);

        const row = await prisma.role.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.name).toBe('Moderator');
        expect(row.serverId).toBe(serverId);
      } finally {
        await app.close();
      }
    });

    it('a non-owner with MANAGE_ROLES still cannot create a role — the new role spawns at the top, at/above the actor (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      // @everyone carries MANAGE_ROLES so memberId can reach the handler, but
      // the member's only role is @everyone (position 0). New roles are created
      // at position max+1 (the top), so the new role sits ABOVE the actor's
      // highest role and requireRoleHierarchy rejects it ("at or above your own
      // highest role"). Only the owner — who bypasses the hierarchy gate — can
      // create roles through this endpoint.
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_ROLES);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Helper', permissions: '0' },
        });
        expect(res.statusCode).toBe(403);
        // No role row was written.
        const count = await prisma.role.count({ where: { serverId, isEveryone: false } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('member WITHOUT MANAGE_ROLES cannot create a role (403), no row written', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId); // @everyone has no MANAGE_ROLES
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'ShouldNotExist' },
        });
        expect(res.statusCode).toBe(403);
        const count = await prisma.role.count({ where: { serverId, isEveryone: false } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('POST /api/servers/:serverId/roles is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${ulid()}/roles`,
          payload: { name: 'Ghost' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('POST /api/servers/:serverId/roles is 400 when name is empty', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: '' }, // min(1) → zod fails
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('hierarchy gate: member with MANAGE_ROLES cannot create a role with perms they lack (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      // @everyone only has MANAGE_ROLES; ADMINISTRATOR is not included.
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_ROLES);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            name: 'Admin',
            permissions: serializePermissions(Permission.ADMINISTRATOR),
          },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  // ─── PATCH /api/roles/:id ─────────────────────────────────────────────────

  describe('PATCH /api/roles/:id', () => {
    it('server owner can update a role (200) — name and color change persisted', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const roleId = await makeRole(serverId, 'OldName', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/roles/${roleId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'NewName', color: 0x123456 },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string; name: string; color: number }>;
        expect(body.data.id).toBe(roleId);
        expect(body.data.name).toBe('NewName');
        expect(body.data.color).toBe(0x123456);

        const row = await prisma.role.findUniqueOrThrow({ where: { id: roleId } });
        expect(row.name).toBe('NewName');
        expect(row.color).toBe(0x123456);
      } finally {
        await app.close();
      }
    });

    it('PATCH /api/roles/:id is 404 for an unknown role', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/roles/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Ghost' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('member WITHOUT MANAGE_ROLES cannot update a role (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const roleId = await makeRole(serverId, 'Target', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/roles/${roleId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Hijacked' },
        });
        expect(res.statusCode).toBe(403);
        const row = await prisma.role.findUniqueOrThrow({ where: { id: roleId } });
        expect(row.name).toBe('Target');
      } finally {
        await app.close();
      }
    });

    it('PATCH /api/roles/:id is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/roles/${ulid()}`,
          payload: { name: 'Nobody' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('partial update — omitting fields leaves them unchanged', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const roleId = await makeRole(serverId, 'Stable', 1);

      // Set initial color
      await prisma.role.update({ where: { id: roleId }, data: { color: 0xaabbcc } });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/roles/${roleId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'RenamedOnly' }, // color not sent
        });
        expect(res.statusCode).toBe(200);
        const row = await prisma.role.findUniqueOrThrow({ where: { id: roleId } });
        expect(row.name).toBe('RenamedOnly');
        expect(row.color).toBe(0xaabbcc); // unchanged
      } finally {
        await app.close();
      }
    });
  });

  // ─── DELETE /api/roles/:id ────────────────────────────────────────────────

  describe('DELETE /api/roles/:id', () => {
    it('server owner can delete a role (200) and the row is gone', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const roleId = await makeRole(serverId, 'Doomed', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/roles/${roleId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.data.id).toBe(roleId);

        const row = await prisma.role.findUnique({ where: { id: roleId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('deleting the @everyone role returns 400 "Cannot delete @everyone"', async () => {
      const ownerId = await makeUser('owner');
      const { everyoneId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/roles/${everyoneId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
        // The @everyone role must still exist.
        const row = await prisma.role.findUnique({ where: { id: everyoneId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE /api/roles/:id is 404 for an unknown role', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/roles/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('member WITHOUT MANAGE_ROLES cannot delete a role (403), row survives', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const roleId = await makeRole(serverId, 'Protected', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/roles/${roleId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        const row = await prisma.role.findUnique({ where: { id: roleId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE /api/roles/:id is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/roles/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ─── PUT /api/servers/:serverId/members/:userId/roles ─────────────────────

  describe('PUT /api/servers/:serverId/members/:userId/roles', () => {
    it('server owner assigns roles to a member (200) — DB rows match', async () => {
      const ownerId = await makeUser('owner');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, targetId);
      const roleId = await makeRole(serverId, 'Bard', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${targetId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: [roleId] },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ serverId: string; userId: string; roles: string[] }>;
        expect(body.data.serverId).toBe(serverId);
        expect(body.data.userId).toBe(targetId);
        expect(body.data.roles).toContain(roleId);

        const rows = await prisma.serverMemberRole.findMany({ where: { serverId, userId: targetId } });
        expect(rows.map((r) => r.roleId)).toContain(roleId);
      } finally {
        await app.close();
      }
    });

    it('assigning an empty roleIds list clears all existing roles (200)', async () => {
      const ownerId = await makeUser('owner');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, targetId);
      const roleId = await makeRole(serverId, 'Temp', 1);
      // Pre-assign the role directly.
      await prisma.serverMemberRole.create({ data: { serverId, userId: targetId, roleId } });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${targetId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: [] },
        });
        expect(res.statusCode).toBe(200);
        const rows = await prisma.serverMemberRole.findMany({
          where: { serverId, userId: targetId },
        });
        expect(rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('unknown role id in roleIds → 400 "Unknown role id", no DB mutation', async () => {
      const ownerId = await makeUser('owner');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, targetId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const fakeRoleId = ulid();
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${targetId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: [fakeRoleId] },
        });
        expect(res.statusCode).toBe(400);
        const rows = await prisma.serverMemberRole.findMany({
          where: { serverId, userId: targetId },
        });
        expect(rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('member not found → 404', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const roleId = await makeRole(serverId, 'Bard', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const nonMemberId = ulid();
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${nonMemberId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: [roleId] },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('member WITHOUT MANAGE_ROLES cannot assign roles (403)', async () => {
      const ownerId = await makeUser('owner');
      const actorId = await makeUser('actor');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId); // no MANAGE_ROLES on @everyone
      await addMember(serverId, actorId);
      await addMember(serverId, targetId);
      const roleId = await makeRole(serverId, 'Bard', 1);

      const app = await buildTestApp();
      try {
        const token = await mintToken(actorId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${targetId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: [roleId] },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('PUT .../roles is 401 without auth', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${ulid()}/members/${ulid()}/roles`,
          payload: { roleIds: [] },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('PUT .../roles is 400 when roleIds is not an array', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${ownerId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: 'not-an-array' }, // zod fails
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('hierarchy gate: non-owner with MANAGE_ROLES cannot assign a role they lack perms for (403)', async () => {
      const ownerId = await makeUser('owner');
      const actorId = await makeUser('actor');
      const targetId = await makeUser('target');
      // @everyone gets MANAGE_ROLES so actorId can reach the route,
      // but actor does NOT hold ADMINISTRATOR.
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_ROLES);
      await addMember(serverId, actorId);
      await addMember(serverId, targetId);
      // Role position 1 < actor maxRolePosition=0  →  hierarchy fails even on position alone
      // To isolate the permissions check: give actor a role with position 5 so position passes,
      // but the target role carries ADMINISTRATOR which actor lacks.
      const actorRoleId = await makeRole(serverId, 'Senior', 5, Permission.MANAGE_ROLES);
      await prisma.serverMemberRole.create({ data: { serverId, userId: actorId, roleId: actorRoleId } });
      // Target role sits below actor (position 2) but carries ADMINISTRATOR.
      const dangerousRoleId = await makeRole(
        serverId,
        'DangerousAdmin',
        2,
        Permission.ADMINISTRATOR,
      );

      const app = await buildTestApp();
      try {
        const token = await mintToken(actorId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/servers/${serverId}/members/${targetId}/roles`,
          headers: { authorization: `Bearer ${token}` },
          payload: { roleIds: [dangerousRoleId] },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });
});
