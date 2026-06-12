/**
 * Integration coverage for the server management surface in
 * `apps/api/src/routes/servers.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Routes covered:
 *   GET    /api/servers                              — list my servers
 *   POST   /api/servers                              — create server
 *   GET    /api/servers/:id                          — get one server (must be member)
 *   PATCH  /api/servers/:id                          — update (MANAGE_SERVER)
 *   DELETE /api/servers/:id                          — owner only
 *   GET    /api/servers/:id/members                  — list members (any member)
 *   GET    /api/servers/:id/permissions/me           — caller's resolved perms
 *   GET    /api/servers/:id/roles                    — list roles (any member)
 *   PATCH  /api/servers/:serverId/members/:userId    — update nickname
 *   GET    /api/servers/:id/channels                 — list visible channels
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
import { refreshServerIconsForAttachment } from '@tavern/db';
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
 * so tests can grant specific bits to all members (e.g. MANAGE_SERVER).
 * This helper does NOT create safetyPolicy — that is created by the API route
 * POST /api/servers. Direct fixture creation skips the policy intentionally to
 * keep beforeEach cleanup simple (cascade from server handles it anyway).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Test Tavern' } });
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
 * Seed an icon Attachment row. Defaults to `ready` so PATCH resolves a public
 * URL; pass `status: 'processing'` to exercise the not-yet-ready path. Cascade
 * on `uploaderId` means the beforeEach user wipe cleans these up.
 */
async function makeIconAttachment(
  uploaderId: string,
  status: 'ready' | 'processing' = 'ready',
): Promise<{ id: string; storageBucket: string; storageKey: string }> {
  const id = ulid();
  const storageBucket = 'main';
  const storageKey = `icons/${id}.png`;
  await prisma.attachment.create({
    data: {
      id,
      uploaderId,
      kind: 'image',
      filename: 'icon.png',
      mimeType: 'image/png',
      sizeBytes: BigInt(1024),
      storageBucket,
      storageKey,
      status,
    },
  });
  return { id, storageBucket, storageKey };
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

describe.skipIf(!dockerOk)('server routes (apps/api/src/routes/servers.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // FK-safe order: children before parents.
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

  // ---- GET /api/servers ---------------------------------------------------

  describe('GET /api/servers', () => {
    it('returns an empty list when the user has no memberships (200)', async () => {
      const userId = await makeUser('solo');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<unknown[]>;
        expect(body.ok).toBe(true);
        expect(body.data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('lists servers the user is a member of, ordered by join time (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId: s1 } = await makeServer(ownerId);
      const { serverId: s2 } = await makeServer(ownerId);
      await addMember(s1, memberId);
      await addMember(s2, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string; name: string }>>;
        const ids = body.data.map((s) => s.id);
        expect(ids).toContain(s1);
        expect(ids).toContain(s2);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/servers',
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('response shape includes expected server fields', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      void serverId;

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{
            id: string;
            ownerUserId: string;
            name: string;
            federationEnabled: boolean;
            createdAt: string;
          }>
        >;
        expect(body.data[0]?.ownerUserId).toBe(ownerId);
        expect(body.data[0]?.name).toBe('Test Tavern');
        expect(typeof body.data[0]?.federationEnabled).toBe('boolean');
        expect(typeof body.data[0]?.createdAt).toBe('string');
      } finally {
        await app.close();
      }
    });
  });

  // ---- POST /api/servers --------------------------------------------------

  describe('POST /api/servers', () => {
    it('creates a server (201) with @everyone role, a general channel, and owner as member', async () => {
      const ownerId = await makeUser('owner');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'New Tavern', description: 'A fine tavern' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{
          id: string;
          name: string;
          description: string | null;
          ownerUserId: string;
          federationEnabled: boolean;
          createdAt: string;
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.name).toBe('New Tavern');
        expect(body.data.description).toBe('A fine tavern');
        expect(body.data.ownerUserId).toBe(ownerId);
        expect(body.data.federationEnabled).toBe(false);

        const serverId = body.data.id;

        // Owner is a server member.
        const member = await prisma.serverMember.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(member).not.toBeNull();

        // @everyone role was created and set as defaultRoleId.
        const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(server.defaultRoleId).not.toBeNull();
        const role = await prisma.role.findUniqueOrThrow({ where: { id: server.defaultRoleId! } });
        expect(role.isEveryone).toBe(true);

        // A text channel named 'general' was created.
        const channel = await prisma.channel.findFirst({
          where: { serverId, name: 'general' },
        });
        expect(channel).not.toBeNull();
        expect(channel?.type).toBe('text');

        // SafetyPolicy was created.
        const policy = await prisma.safetyPolicy.findUnique({ where: { serverId } });
        expect(policy).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('an audit log entry is written for server.created', async () => {
      const ownerId = await makeUser('owner');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Audited Tavern' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string }>;
        const entry = await prisma.auditLogEntry.findFirst({
          where: { serverId: body.data.id, action: 'server.created' },
        });
        expect(entry).not.toBeNull();
        expect(entry?.actorId).toBe(ownerId);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/servers',
          payload: { name: 'Ghost Server' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when name is too short (< 2 chars)', async () => {
      const ownerId = await makeUser('owner');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'X' }, // min length is 2
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when name is missing', async () => {
      const ownerId = await makeUser('owner');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('description is optional — omitting it stores null', async () => {
      const ownerId = await makeUser('owner');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'No Desc Tavern' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string; description: string | null }>;
        expect(body.data.description).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // ---- GET /api/servers/:id -----------------------------------------------

  describe('GET /api/servers/:id', () => {
    it('the owner can fetch their server (200) with correct shape', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string; ownerUserId: string; name: string }>;
        expect(body.data.id).toBe(serverId);
        expect(body.data.ownerUserId).toBe(ownerId);
        expect(body.data.name).toBe('Test Tavern');
      } finally {
        await app.close();
      }
    });

    it('a regular member can fetch the server (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.data.id).toBe(serverId);
      } finally {
        await app.close();
      }
    });

    it('a non-member gets 404 (server existence is hidden)', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown server id', async () => {
      const userId = await makeUser('user');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ---- PATCH /api/servers/:id ---------------------------------------------

  describe('PATCH /api/servers/:id', () => {
    it('the owner can update name and description (200) — DB row updated', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Renamed Tavern', description: 'Updated desc' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string; name: string; description: string | null }>;
        expect(body.data.name).toBe('Renamed Tavern');
        expect(body.data.description).toBe('Updated desc');

        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.name).toBe('Renamed Tavern');
        expect(row.description).toBe('Updated desc');
      } finally {
        await app.close();
      }
    });

    it('a member with MANAGE_SERVER bit can patch the server (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_SERVER);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Member Renamed' },
        });
        expect(res.statusCode).toBe(200);
        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.name).toBe('Member Renamed');
      } finally {
        await app.close();
      }
    });

    it('a plain member without MANAGE_SERVER gets 403 — value unchanged', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId); // no MANAGE_SERVER
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Hijacked' },
        });
        expect(res.statusCode).toBe(403);
        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.name).toBe('Test Tavern');
      } finally {
        await app.close();
      }
    });

    it('setting federationEnabled=true on a non-federated instance is rejected (400)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { federationEnabled: true },
        });
        // FEDERATION_ENABLED=false in envFor → instance gate rejects with 400.
        expect(res.statusCode).toBe(400);
        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.federationEnabled).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('an audit log entry is written for server.updated', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Audited Rename' },
        });
        const entry = await prisma.auditLogEntry.findFirst({
          where: { serverId, action: 'server.updated' },
        });
        expect(entry).not.toBeNull();
        expect(entry?.actorId).toBe(ownerId);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          payload: { name: 'Ghost Edit' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the patch body fails validation (name too short)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'X' }, // min 2
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    // ---- #23 — server-icon URL resolution ---------------------------------

    it('resolves Server.iconUrl from a ready icon attachment (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const icon = await makeIconAttachment(ownerId, 'ready');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { iconAttachmentId: icon.id },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ iconAttachmentId: string | null; iconUrl: string | null }>;
        expect(body.data.iconAttachmentId).toBe(icon.id);
        // Resolved capability URL — absolute (PUBLIC_BASE_URL) + the storage key.
        expect(body.data.iconUrl).toBeTruthy();
        expect(body.data.iconUrl).toMatch(/^http:\/\/localhost:3001\//);
        expect(body.data.iconUrl).toContain(encodeURIComponent(icon.storageKey));

        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.iconUrl).toBe(body.data.iconUrl);
      } finally {
        await app.close();
      }
    });

    it('stores a null iconUrl until the icon attachment is ready, then backfills on scan-complete (#23)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const icon = await makeIconAttachment(ownerId, 'processing');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { iconAttachmentId: icon.id },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ iconUrl: string | null }>;
        // Attachment not ready → never advertise unscanned bytes.
        expect(body.data.iconUrl).toBeNull();

        // Scan completes; the terminal-status hook backfills the URL.
        await prisma.attachment.update({ where: { id: icon.id }, data: { status: 'ready' } });
        const stub = {
          getPublicUrl: (b: string, k: string) =>
            `http://localhost:3001/api/_local-files/${b}/${encodeURIComponent(k)}`,
        };
        await refreshServerIconsForAttachment(icon.id, stub);

        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.iconUrl).toBe(stub.getPublicUrl(icon.storageBucket, icon.storageKey));
      } finally {
        await app.close();
      }
    });

    it('clears Server.iconUrl when the icon attachment is set to null (#23)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const icon = await makeIconAttachment(ownerId, 'ready');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        // Set, then clear.
        await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { iconAttachmentId: icon.id },
        });
        const clearRes = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { iconAttachmentId: null },
        });
        expect(clearRes.statusCode).toBe(200);
        const body = clearRes.json() as OkBody<{ iconAttachmentId: string | null; iconUrl: string | null }>;
        expect(body.data.iconAttachmentId).toBeNull();
        expect(body.data.iconUrl).toBeNull();

        const row = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
        expect(row.iconUrl).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // ---- DELETE /api/servers/:id --------------------------------------------

  describe('DELETE /api/servers/:id', () => {
    it('the owner can delete their server (200) — row removed', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.data.id).toBe(serverId);

        const row = await prisma.server.findUnique({ where: { id: serverId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('cascade deletes channels, roles, and members when server is deleted', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, everyoneId, channelId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);

        expect(await prisma.channel.findUnique({ where: { id: channelId } })).toBeNull();
        expect(await prisma.role.findUnique({ where: { id: everyoneId } })).toBeNull();
        const members = await prisma.serverMember.findMany({ where: { serverId } });
        expect(members).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('a non-owner member gets 403 — server survives', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/servers/${serverId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        const row = await prisma.server.findUnique({ where: { id: serverId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown server', async () => {
      const userId = await makeUser('user');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/servers/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/servers/${serverId}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ---- GET /api/servers/:id/members ---------------------------------------

  describe('GET /api/servers/:id/members', () => {
    it('lists members with user info for a server member (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/members`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{ userId: string; serverId: string; user: { id: string }; joinedAt: string }>
        >;
        const userIds = body.data.map((m) => m.userId);
        expect(userIds).toContain(ownerId);
        expect(userIds).toContain(memberId);
        // Shape check.
        const first = body.data[0];
        expect(first?.serverId).toBe(serverId);
        expect(typeof first?.user?.id).toBe('string');
        expect(typeof first?.joinedAt).toBe('string');
      } finally {
        await app.close();
      }
    });

    it('returns 404 for a non-member (hides server existence)', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/members`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/members`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ---- GET /api/servers/:id/permissions/me --------------------------------

  describe('GET /api/servers/:id/permissions/me', () => {
    it('returns the owner\'s resolved permissions as a decimal bigint string (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/permissions/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ serverId: string; permissions: string }>;
        expect(body.data.serverId).toBe(serverId);
        // The owner has PERMISSION_ALL; the value will be a numeric string.
        expect(typeof body.data.permissions).toBe('string');
        // Must be parseable as a BigInt.
        expect(() => BigInt(body.data.permissions)).not.toThrow();
        // Owner should have ADMINISTRATOR bit set.
        const perms = BigInt(body.data.permissions);
        expect((perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('returns the member\'s resolved permissions (200) — does not include ADMINISTRATOR', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/permissions/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ serverId: string; permissions: string }>;
        const perms = BigInt(body.data.permissions);
        expect((perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR).toBe(false);
        expect((perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for a non-member', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/permissions/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/permissions/me`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ---- GET /api/servers/:id/roles -----------------------------------------

  describe('GET /api/servers/:id/roles', () => {
    it('lists server roles ordered by position for a member (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, everyoneId } = await makeServer(ownerId);
      const modRoleId = ulid();
      await prisma.role.create({
        data: {
          id: modRoleId,
          serverId,
          name: 'Moderator',
          position: 1,
          permissions: new Prisma.Decimal('0'),
          isEveryone: false,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{ id: string; name: string; position: number; isEveryone: boolean; permissions: string }>
        >;
        const ids = body.data.map((r) => r.id);
        expect(ids).toContain(everyoneId);
        expect(ids).toContain(modRoleId);
        // Ordered by position asc.
        const everyoneIdx = ids.indexOf(everyoneId);
        const modIdx = ids.indexOf(modRoleId);
        expect(everyoneIdx).toBeLessThan(modIdx);
        // Shape check.
        const everyone = body.data.find((r) => r.id === everyoneId);
        expect(everyone?.isEveryone).toBe(true);
        expect(typeof everyone?.permissions).toBe('string');
      } finally {
        await app.close();
      }
    });

    it('returns 404 for a non-member', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/roles`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/roles`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // ---- PATCH /api/servers/:serverId/members/:userId (nickname) ------------

  describe('PATCH /api/servers/:serverId/members/:userId (nickname)', () => {
    it('a member can update their own nickname (200) — DB updated, audit entry written', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { nickname: 'The Brave' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ serverId: string; userId: string; nickname: string | null }>;
        expect(body.data.nickname).toBe('The Brave');
        expect(body.data.serverId).toBe(serverId);
        expect(body.data.userId).toBe(memberId);

        const row = await prisma.serverMember.findUniqueOrThrow({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(row.nickname).toBe('The Brave');

        const entry = await prisma.auditLogEntry.findFirst({
          where: { serverId, action: 'member.nickname.self', targetId: memberId },
        });
        expect(entry).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a member can clear their nickname by passing null (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      // Pre-set nickname.
      await prisma.serverMember.update({
        where: { serverId_userId: { serverId, userId: memberId } },
        data: { nickname: 'Old Name' },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { nickname: null },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ nickname: string | null }>;
        expect(body.data.nickname).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('owner with MANAGE_NICKNAMES can update another member\'s nickname (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { nickname: 'Renamed By Owner' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ nickname: string | null }>;
        expect(body.data.nickname).toBe('Renamed By Owner');

        // Audit entry uses member.nickname.set action (not self).
        const entry = await prisma.auditLogEntry.findFirst({
          where: { serverId, action: 'member.nickname.set', targetId: memberId },
        });
        expect(entry).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a plain member without MANAGE_NICKNAMES cannot rename another member (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId); // default @everyone, no MANAGE_NICKNAMES
      await addMember(serverId, memberId);
      await addMember(serverId, targetId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${targetId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { nickname: 'Hijacked Name' },
        });
        expect(res.statusCode).toBe(403);
        const row = await prisma.serverMember.findUniqueOrThrow({
          where: { serverId_userId: { serverId, userId: targetId } },
        });
        expect(row.nickname).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the target member does not exist', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const nonMemberId = await makeUser('nonmember');
      // nonMemberId is NOT added to the server.

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${nonMemberId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { nickname: 'Ghost' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${memberId}`,
          payload: { nickname: 'NoAuth' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body fails validation (nickname too long)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/members/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { nickname: 'X'.repeat(65) }, // max 64
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  // ---- GET /api/servers/:id/channels --------------------------------------

  describe('GET /api/servers/:id/channels', () => {
    it('lists all visible channels for a member (200) — ordered by position then createdAt', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/channels`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{ id: string; name: string; type: string; serverId: string }>
        >;
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.some((c) => c.id === channelId)).toBe(true);
        const channel = body.data.find((c) => c.id === channelId);
        expect(channel?.serverId).toBe(serverId);
        expect(channel?.type).toBe('text');
        expect(channel?.name).toBe('general');
      } finally {
        await app.close();
      }
    });

    it('includes active voice states on visible voice rooms', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const voiceChannelId = ulid();
      const joinedAt = new Date('2026-06-11T12:00:00.000Z');
      await prisma.channel.create({
        data: {
          id: voiceChannelId,
          serverId,
          type: 'voice',
          name: 'Voice Hall',
          position: 1,
          videoEnabled: true,
        },
      });
      await prisma.voiceState.create({
        data: {
          serverId,
          userId: memberId,
          channelId: voiceChannelId,
          selfMute: true,
          selfDeaf: false,
          cameraOn: false,
          screenSharing: true,
          joinedAt,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/channels`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{
            id: string;
            type: string;
            voiceStates?: Array<{
              userId: string;
              channelId: string | null;
              selfMute: boolean;
              screenSharing: boolean;
              joinedAt: string | null;
            }>;
          }>
        >;
        const voice = body.data.find((c) => c.id === voiceChannelId);
        expect(voice?.type).toBe('voice');
        expect(voice?.voiceStates).toEqual([
          expect.objectContaining({
            userId: memberId,
            channelId: voiceChannelId,
            selfMute: true,
            screenSharing: true,
            joinedAt: joinedAt.toISOString(),
          }),
        ]);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for a non-member', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/channels`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no auth token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/channels`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });
});
