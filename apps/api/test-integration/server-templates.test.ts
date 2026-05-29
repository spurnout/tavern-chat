/**
 * Integration coverage for the server-template surface in
 * `apps/api/src/routes/server-templates.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Routes covered:
 *   GET    /api/server-templates                — list (auth required)
 *   POST   /api/server-templates                — create from server (MANAGE_SERVER)
 *   POST   /api/server-templates/:id/instantiate — create new server from template
 *   DELETE /api/server-templates/:id            — author only
 *
 * Federation is off so no route touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, Permission, serializePermissions, ulid } from '@tavern/shared';
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
 * Create a server owned by `ownerId` with an @everyone role + one text
 * channel. `extraEveryonePerms` is OR-ed onto the default @everyone bitset
 * (e.g. Permission.MANAGE_SERVER to grant it to all members).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Template Tavern' } });
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

/** Directly insert a ServerTemplate row (bypass the API). Returns the template id. */
async function makeTemplate(authorId: string, name = 'My Template'): Promise<string> {
  const id = ulid();
  await prisma.serverTemplate.create({
    data: {
      id,
      authorId,
      name,
      payloadJson: {
        version: 1,
        server: { name: 'Seed Server', description: null },
        channels: [{ type: 'text', name: 'general', topic: null, position: 0, nsfw: false, videoEnabled: false, parentName: null }],
        roles: [],
      },
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

describe.skipIf(!dockerOk)('server-template routes (apps/api/src/routes/server-templates.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // FK-safe order: children before parents.
    await prisma.apiToken.deleteMany({});
    await prisma.serverTemplate.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/server-templates ------------------------------------------

  describe('GET /api/server-templates', () => {
    it('returns an empty list when there are no templates (200)', async () => {
      const userId = await makeUser('viewer');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<unknown[]>;
        expect(body.ok).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('lists all templates ordered newest-first (200)', async () => {
      const userId = await makeUser('viewer');
      const id1 = await makeTemplate(userId, 'Alpha');
      const id2 = await makeTemplate(userId, 'Beta');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string; name: string }>>;
        // Both templates appear; the newest insert (Beta) first.
        const ids = body.data.map((t) => t.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
        // createdAt ordering: Beta was inserted after Alpha, so Beta should appear first.
        expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/server-templates',
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ---- POST /api/server-templates -----------------------------------------

  describe('POST /api/server-templates', () => {
    it('server owner can create a template (201) with channels and roles snapshotted', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServer(ownerId);
      // Add a category channel and a non-everyone role for richer snapshot.
      await prisma.channel.create({
        data: { id: ulid(), serverId, type: 'category', name: 'Info', position: 0 },
      });
      await prisma.role.create({
        data: {
          id: ulid(),
          serverId,
          name: 'Mod',
          position: 1,
          permissions: new Prisma.Decimal('0'),
          isEveryone: false,
          mentionable: false,
          hoist: false,
        },
      });
      void channelId;

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { serverId, name: 'My Snapshot', description: 'A great template' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{
          id: string;
          name: string;
          description: string | null;
          authorId: string;
          payloadJson: {
            version: number;
            channels: Array<{ name: string }>;
            roles: Array<{ name: string }>;
          };
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.name).toBe('My Snapshot');
        expect(body.data.description).toBe('A great template');
        expect(body.data.authorId).toBe(ownerId);
        expect(body.data.payloadJson.version).toBe(1);
        // Channels includes the text channel and the category.
        const chanNames = body.data.payloadJson.channels.map((c) => c.name);
        expect(chanNames).toContain('general');
        expect(chanNames).toContain('Info');
        // Non-everyone roles are included; @everyone is excluded.
        const roleNames = body.data.payloadJson.roles.map((r) => r.name);
        expect(roleNames).toContain('Mod');
        expect(roleNames).not.toContain('@everyone');

        // Verify row written to DB.
        const row = await prisma.serverTemplate.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.authorId).toBe(ownerId);
        expect(row.name).toBe('My Snapshot');
      } finally {
        await app.close();
      }
    });

    it('a member with MANAGE_SERVER bit can create a template (201)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_SERVER);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { serverId, name: 'Member Template' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string; authorId: string }>;
        expect(body.data.authorId).toBe(memberId);
      } finally {
        await app.close();
      }
    });

    it('a plain member without MANAGE_SERVER cannot create a template (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId); // default @everyone, no MANAGE_SERVER
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { serverId, name: 'Unauthorized' },
        });
        expect(res.statusCode).toBe(403);
        // No row written.
        const count = await prisma.serverTemplate.count();
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          payload: { serverId: ulid(), name: 'Ghost' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body fails validation (empty name)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { serverId, name: '' }, // min(1) fails
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body fails validation (missing serverId)', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'No Server' }, // serverId missing
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('throws when the server does not exist (the permission check 404s or permission-service throws)', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { serverId: ulid(), name: 'Ghost Template' },
        });
        // Non-member of a nonexistent server → 403 from requireServerPermission.
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('template description is optional — omitting it stores null', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/server-templates',
          headers: { authorization: `Bearer ${token}` },
          payload: { serverId, name: 'No Desc' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string; description: string | null }>;
        expect(body.data.description).toBeNull();
        const row = await prisma.serverTemplate.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.description).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // ---- POST /api/server-templates/:id/instantiate -------------------------

  describe('POST /api/server-templates/:id/instantiate', () => {
    it('any authenticated user can instantiate a template (201) — new server is created', async () => {
      const authorId = await makeUser('author');
      const userId = await makeUser('user');
      const tplId = await makeTemplate(authorId, 'Test Template');

      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/server-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'My New Server' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string; name: string }>;
        expect(body.ok).toBe(true);
        expect(body.data.name).toBe('My New Server');

        // A server row was created with the caller as owner.
        const server = await prisma.server.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(server.name).toBe('My New Server');
        expect(server.ownerUserId).toBe(userId);

        // The caller is a member of the new server.
        const member = await prisma.serverMember.findUnique({
          where: { serverId_userId: { serverId: body.data.id, userId } },
        });
        expect(member).not.toBeNull();

        // An @everyone role was created.
        const roles = await prisma.role.findMany({ where: { serverId: body.data.id } });
        const everyone = roles.find((r) => r.isEveryone);
        expect(everyone).toBeDefined();
      } finally {
        await app.close();
      }
    });

    it('instantiate preserves text channels from the template payload', async () => {
      const authorId = await makeUser('author');
      // Build a template with two text channels (one in a category).
      const tplId = ulid();
      await prisma.serverTemplate.create({
        data: {
          id: tplId,
          authorId,
          name: 'Rich Template',
          payloadJson: {
            version: 1,
            server: { name: 'Source', description: null },
            channels: [
              { type: 'category', name: 'Cat', topic: null, position: 0, nsfw: false, videoEnabled: false, parentName: null },
              { type: 'text', name: 'chat', topic: 'Say hi', position: 1, nsfw: false, videoEnabled: false, parentName: 'Cat' },
              { type: 'text', name: 'off-topic', topic: null, position: 2, nsfw: false, videoEnabled: false, parentName: null },
            ],
            roles: [
              { name: 'Mod', color: 0xff0000, position: 1, permissions: '0', mentionable: true, hoist: false },
            ],
          },
        },
      });

      const userId = await makeUser('user');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/server-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Recreated Server' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string }>;
        const newServerId = body.data.id;

        // Check channels: category + 2 text channels.
        const channels = await prisma.channel.findMany({ where: { serverId: newServerId } });
        const chanNames = channels.map((c) => c.name);
        expect(chanNames).toContain('Cat');
        expect(chanNames).toContain('chat');
        expect(chanNames).toContain('off-topic');

        // The 'chat' channel should have its parent pointing to Cat's id.
        const catChannel = channels.find((c) => c.name === 'Cat');
        const chatChannel = channels.find((c) => c.name === 'chat');
        expect(chatChannel?.parentId).toBe(catChannel?.id);

        // Check custom role 'Mod' was created.
        const roles = await prisma.role.findMany({ where: { serverId: newServerId } });
        const modRole = roles.find((r) => r.name === 'Mod');
        expect(modRole).toBeDefined();
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the template does not exist', async () => {
      const userId = await makeUser('user');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/server-templates/${ulid()}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Phantom Server' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const authorId = await makeUser('author');
      const tplId = await makeTemplate(authorId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/server-templates/${tplId}/instantiate`,
          payload: { name: 'Unauthenticated' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body fails validation (empty name)', async () => {
      const userId = await makeUser('user');
      const authorId = await makeUser('author');
      const tplId = await makeTemplate(authorId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/server-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: '' }, // min(1) fails
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  // ---- DELETE /api/server-templates/:id -----------------------------------

  describe('DELETE /api/server-templates/:id', () => {
    it('the author can delete their own template (200) — row removed', async () => {
      const userId = await makeUser('author');
      const tplId = await makeTemplate(userId, 'To Delete');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/server-templates/${tplId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.ok).toBe(true);
        expect(body.data.id).toBe(tplId);

        const row = await prisma.serverTemplate.findUnique({ where: { id: tplId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a different user cannot delete a template they do not own (403) — row survives', async () => {
      const authorId = await makeUser('author');
      const otherId = await makeUser('other');
      const tplId = await makeTemplate(authorId, 'Protected');
      const app = await buildTestApp();
      try {
        const token = await mintToken(otherId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/server-templates/${tplId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);

        const row = await prisma.serverTemplate.findUnique({ where: { id: tplId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the template does not exist', async () => {
      const userId = await makeUser('user');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/server-templates/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const authorId = await makeUser('author');
      const tplId = await makeTemplate(authorId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/server-templates/${tplId}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });
});
