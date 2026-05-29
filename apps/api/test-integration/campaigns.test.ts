/**
 * Integration coverage for the server-scoped campaign surface in
 * `apps/api/src/routes/campaigns.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - GET /api/servers/:serverId/campaigns: any server member (perms !== 0n) can list
 *   - POST /api/servers/:serverId/campaigns: requires CREATE_CAMPAIGNS permission
 *   - GET /api/campaigns/:id: any server member can view
 *   - PATCH /api/campaigns/:id: GM (gmUserId === caller) or MANAGE_CAMPAIGNS
 *   - unknown server / campaign → 404, bad body → 400
 *
 * Fixtures: a server (owner == GM) with an @everyone role, one text channel.
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
 * A server owned by `ownerId` with an @everyone role + one text channel and
 * the owner as a member. `extraEveryonePerms` is OR-ed onto the default
 * @everyone bitset (e.g. to grant CREATE_CAMPAIGNS to every member).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Campaign Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'table' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

async function makeCampaign(serverId: string, gmUserId: string, name = 'The Lost Mine'): Promise<string> {
  const id = ulid();
  await prisma.campaign.create({
    data: { id, serverId, name, gmUserId },
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

describe.skipIf(!dockerOk)('campaign routes (apps/api/src/routes/campaigns.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.sessionRecap.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.auditLogEntry.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/servers/:serverId/campaigns --------------------------------

  it('lists campaigns for a server member, ordered newest first (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const id1 = await makeCampaign(serverId, ownerId, 'Alpha');
    // small delay to ensure distinct createdAt ordering
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await makeCampaign(serverId, ownerId, 'Beta');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; name: string; serverId: string }>>;
      expect(body.ok).toBe(true);
      expect(body.data.length).toBe(2);
      // newest first
      expect(body.data[0]?.id).toBe(id2);
      expect(body.data[1]?.id).toBe(id1);
      expect(body.data.every((c) => c.serverId === serverId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:serverId/campaigns returns empty array when no campaigns exist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:serverId/campaigns is 404 for an unknown server', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
      });
      // non-member → perms === 0n → notFound
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:serverId/campaigns is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/campaigns`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // A non-member user who is authenticated still gets 404 (perms === 0n branch)
  it('GET /api/servers/:serverId/campaigns is 404 for an authenticated non-member', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    // outsider is NOT added as a member

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/servers/:serverId/campaigns --------------------------------

  it('server owner can create a campaign (201) — owner bypasses permission gates, is added as co_gm member', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Curse of Strahd', description: 'Gothic horror', gameSystem: 'dnd5e' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        serverId: string;
        name: string;
        description: string | null;
        gameSystem: string | null;
        gmUserId: string;
        status: string;
      }>;
      expect(body.data.name).toBe('Curse of Strahd');
      expect(body.data.description).toBe('Gothic horror');
      expect(body.data.gameSystem).toBe('dnd5e');
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.gmUserId).toBe(ownerId);
      expect(body.data.status).toBe('planning');

      // DB state: campaign row + campaignMember co_gm row
      const row = await prisma.campaign.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.gmUserId).toBe(ownerId);
      const member = await prisma.campaignMember.findUnique({
        where: { campaignId_userId: { campaignId: body.data.id, userId: ownerId } },
      });
      expect(member?.role).toBe('co_gm');
    } finally {
      await app.close();
    }
  });

  it('a plain server member with CREATE_CAMPAIGNS can create a campaign (201)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    // give everyone CREATE_CAMPAIGNS so the plain member can create
    const { serverId } = await makeServer(ownerId, Permission.CREATE_CAMPAIGNS);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Member Campaign' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; gmUserId: string }>;
      expect(body.data.gmUserId).toBe(memberId);

      const count = await prisma.campaign.count({ where: { serverId } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('a plain server member WITHOUT CREATE_CAMPAIGNS cannot create a campaign (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    // default @everyone does NOT include CREATE_CAMPAIGNS
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Sneaky Campaign' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.campaign.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:serverId/campaigns is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${ulid()}/campaigns`,
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:serverId/campaigns is 400 when name is missing', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // name is required
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:serverId/campaigns is 400 when name is empty string', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:serverId/campaigns with safetyBoundaries array is 201', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/campaigns`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Safe Campaign',
          safetyBoundaries: [{ topic: 'violence', action: 'fade_to_black' }],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ safetyBoundaries: unknown[] }>;
      expect(Array.isArray(body.data.safetyBoundaries)).toBe(true);
      expect((body.data.safetyBoundaries as Array<{ topic: string }>)[0]?.topic).toBe('violence');
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/campaigns/:id -----------------------------------------------

  it('GET /api/campaigns/:id returns the campaign to a server member (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; name: string; serverId: string }>;
      expect(body.data.id).toBe(campaignId);
      expect(body.data.name).toBe('The Lost Mine');
      expect(body.data.serverId).toBe(serverId);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id is 404 for an unknown campaign', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id is 404 when the caller is not a member of the server that owns the campaign', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    // outsider is NOT added to the server
    const campaignId = await makeCampaign(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      // perms === 0n → notFound
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/campaigns/:id -----------------------------------------------

  it('the GM (gmUserId) can update their campaign (200) and changes persist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const campaignId = await makeCampaign(serverId, ownerId, 'Old Name');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'New Name', description: 'Updated', status: 'active' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; name: string; description: string | null; status: string }>;
      expect(body.data.name).toBe('New Name');
      expect(body.data.description).toBe('Updated');
      expect(body.data.status).toBe('active');

      const row = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(row.name).toBe('New Name');
      expect((row.status as string)).toBe('active');
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_CAMPAIGNS (but who is not GM) can update (200)', async () => {
    const ownerId = await makeUser('owner');
    const adminId = await makeUser('admin');
    // give everyone MANAGE_CAMPAIGNS
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_CAMPAIGNS);
    await addMember(serverId, adminId);
    const campaignId = await makeCampaign(serverId, ownerId, 'Before');

    const app = await buildTestApp();
    try {
      const token = await mintToken(adminId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'After' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(row.name).toBe('After');
    } finally {
      await app.close();
    }
  });

  it('a plain member who is NOT the GM and lacks MANAGE_CAMPAIGNS cannot update (403), value unchanged', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, ownerId, 'Locked');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(row.name).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/campaigns/:id is 404 for an unknown campaign', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/campaigns/:id is 400 when status value is invalid', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const campaignId = await makeCampaign(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'not-a-valid-status' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/campaigns/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${ulid()}`,
        payload: { name: 'Nobody' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/campaigns/:id supports partial updates (only provided fields change)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const campaignId = await makeCampaign(serverId, ownerId, 'Original Name');

    // First set description
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { description: 'Original Description' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      // Patch only the status — name and description should remain unchanged
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'active' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string; description: string | null; status: string }>;
      expect(body.data.name).toBe('Original Name');
      expect(body.data.description).toBe('Original Description');
      expect(body.data.status).toBe('active');
    } finally {
      await app.close();
    }
  });
});
