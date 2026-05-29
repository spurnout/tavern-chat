/**
 * Integration coverage for the campaign-scoped battle-map surface in
 * `apps/api/src/routes/battle-maps.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode (via `loadCampaignContext`):
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent.
 *   - the campaign's GM may always read/mutate. Anyone else falls back to the
 *     server-level MANAGE_CAMPAIGNS permission. Crucially, a plain CampaignMember
 *     (a *player*) is NOT the GM and does NOT hold MANAGE_CAMPAIGNS by default,
 *     so they are rejected with 403 — battle maps are GM/admin tooling.
 *   - maps/scenes/tokens are reached transitively (token → scene → map →
 *     campaign), so the same campaign gate applies to every nested resource.
 *   - missing campaign / map / scene / token → 404, bad body → 400.
 *
 * Fixtures: a server (owner == GM) with an @everyone role + one text channel,
 * a campaign with an explicit GM. `extraEveryonePerms` can grant
 * MANAGE_CAMPAIGNS to every member to exercise the non-GM-allowed path.
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
 * @everyone bitset (e.g. to grant MANAGE_CAMPAIGNS to every member).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Battle Tavern' } });
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

async function makeCampaign(serverId: string, gmUserId: string): Promise<string> {
  const id = ulid();
  await prisma.campaign.create({ data: { id, serverId, name: 'The Lost Mine', gmUserId } });
  return id;
}

/** Enrol `userId` as a player (the default CampaignRole) in `campaignId`. */
async function addCampaignMember(campaignId: string, userId: string): Promise<void> {
  await prisma.campaignMember.create({ data: { campaignId, userId, role: 'player' } });
}

async function makeMap(campaignId: string, createdBy: string, name = 'Dungeon Level 1'): Promise<string> {
  const id = ulid();
  await prisma.battleMap.create({
    data: { id, campaignId, name, width: 20, height: 20, createdBy },
  });
  return id;
}

async function makeScene(mapId: string, name = 'Entrance', isActive = false): Promise<string> {
  const id = ulid();
  await prisma.battleScene.create({ data: { id, mapId, name, isActive } });
  return id;
}

async function makeBattleToken(sceneId: string, label = 'Goblin'): Promise<string> {
  const id = ulid();
  await prisma.battleToken.create({ data: { id, sceneId, label } });
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

describe.skipIf(!dockerOk)('battle-map routes (apps/api/src/routes/battle-maps.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.battleToken.deleteMany({});
    await prisma.battleScene.deleteMany({});
    await prisma.battleMap.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/campaigns/:id/maps -------------------------------------

  it('the GM can list campaign maps (200), newest first, with nested scenes + tokens', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const older = await makeMap(campaignId, gmId, 'Older');
    // ensure a distinct updatedAt ordering (orderBy updatedAt desc)
    const newer = await makeMap(campaignId, gmId, 'Newer');
    const sceneId = await makeScene(newer, 'Hall', true);
    await makeBattleToken(sceneId, 'Boss');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/maps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<
        Array<{ id: string; name: string; scenes: Array<{ id: string; tokens: Array<{ label: string }> }> }>
      >;
      expect(body.data.map((m) => m.id)).toEqual([newer, older]);
      const newRow = body.data.find((m) => m.id === newer)!;
      expect(newRow.scenes).toHaveLength(1);
      expect(newRow.scenes[0]!.tokens.map((t) => t.label)).toEqual(['Boss']);
    } finally {
      await app.close();
    }
  });

  it('a member WITH MANAGE_CAMPAIGNS (non-GM) can list maps (200)', async () => {
    const gmId = await makeUser('gm');
    const adminId = await makeUser('admin');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGNS);
    await addMember(serverId, adminId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeMap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(adminId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/maps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a plain campaign player (no MANAGE_CAMPAIGNS) cannot list maps (403)', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId); // default perms only
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId); // a player, but NOT the GM
    await makeMap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/maps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET .../maps is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/maps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../maps without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/campaigns/${ulid()}/maps` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/campaigns/:id/maps ------------------------------------

  it('the GM can create a map (201) with defaulted dimensions; the row persists', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/maps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Crypt' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; name: string; width: number; height: number; campaignId: string }>;
      expect(body.data.name).toBe('Crypt');
      expect(body.data.width).toBe(20);
      expect(body.data.height).toBe(20);
      expect(body.data.campaignId).toBe(campaignId);

      const row = await prisma.battleMap.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.createdBy).toBe(gmId);
    } finally {
      await app.close();
    }
  });

  it('POST .../maps is 400 when the body fails validation (empty name)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/maps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(await prisma.battleMap.count({ where: { campaignId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('a plain player cannot create a map (403), no row written', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/maps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Sneaky Map' },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.battleMap.count({ where: { campaignId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/maps/:id --------------------------------------------

  it('the GM can delete a map (200) and the row is gone', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/maps/${mapId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(mapId);
      expect(await prisma.battleMap.findUnique({ where: { id: mapId } })).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/maps/:id is 404 for an unknown map', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/maps/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a plain player cannot delete a map (403), the row survives', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const mapId = await makeMap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/maps/${mapId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.battleMap.findUnique({ where: { id: mapId } })).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/maps/:id/scenes ---------------------------------------

  it('the GM can create a scene on a map (201); the row persists', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/maps/${mapId}/scenes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Throne Room' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; mapId: string; name: string }>;
      expect(body.data.mapId).toBe(mapId);
      expect(body.data.name).toBe('Throne Room');
      const row = await prisma.battleScene.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.mapId).toBe(mapId);
    } finally {
      await app.close();
    }
  });

  it('POST /api/maps/:id/scenes is 404 for an unknown map', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/maps/${ulid()}/scenes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Orphan Scene' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/scenes/:id/activate -----------------------------------

  it('activating a scene marks it active and deactivates its siblings on the same map (200)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);
    const sceneA = await makeScene(mapId, 'A', true); // currently active
    const sceneB = await makeScene(mapId, 'B', false);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenes/${sceneB}/activate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const a = await prisma.battleScene.findUniqueOrThrow({ where: { id: sceneA } });
      const b = await prisma.battleScene.findUniqueOrThrow({ where: { id: sceneB } });
      expect(a.isActive).toBe(false);
      expect(b.isActive).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /api/scenes/:id/activate is 404 for an unknown scene', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenes/${ulid()}/activate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/scenes/:id/tokens -------------------------------------

  it('the GM can add a token to a scene (201) with defaulted coords; the row persists', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);
    const sceneId = await makeScene(mapId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenes/${sceneId}/tokens`,
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 'Hero', x: 3, y: 4, isPc: true },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; sceneId: string; label: string; x: number; y: number; w: number; isPc: boolean }>;
      expect(body.data.sceneId).toBe(sceneId);
      expect(body.data.label).toBe('Hero');
      expect(body.data.x).toBe(3);
      expect(body.data.y).toBe(4);
      expect(body.data.w).toBe(1); // defaulted
      expect(body.data.isPc).toBe(true);
      const row = await prisma.battleToken.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.sceneId).toBe(sceneId);
    } finally {
      await app.close();
    }
  });

  it('POST /api/scenes/:id/tokens is 400 when the body fails validation (empty label)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);
    const sceneId = await makeScene(mapId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenes/${sceneId}/tokens`,
        headers: { authorization: `Bearer ${token}` },
        payload: { label: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(await prisma.battleToken.count({ where: { sceneId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/scenes/:id/tokens is 404 for an unknown scene', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenes/${ulid()}/tokens`,
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 'Orphan' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/tokens/:id -------------------------------------------

  it('the GM can patch a token (200) and only supplied fields change', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);
    const sceneId = await makeScene(mapId);
    const tokenId = await makeBattleToken(sceneId, 'Before');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tokens/${tokenId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 'After', hp: 12, x: 7 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ label: string; hp: number | null; x: number }>;
      expect(body.data.label).toBe('After');
      expect(body.data.hp).toBe(12);
      expect(body.data.x).toBe(7);
      const row = await prisma.battleToken.findUniqueOrThrow({ where: { id: tokenId } });
      expect(row.label).toBe('After');
      expect(row.hp).toBe(12);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/tokens/:id is 404 for an unknown token', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tokens/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a plain player cannot patch a token (403), the value is unchanged', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const mapId = await makeMap(campaignId, gmId);
    const sceneId = await makeScene(mapId);
    const tokenId = await makeBattleToken(sceneId, 'Locked');

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tokens/${tokenId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.battleToken.findUniqueOrThrow({ where: { id: tokenId } });
      expect(row.label).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/tokens/:id ------------------------------------------

  it('the GM can delete a token (200) and the row is gone', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const mapId = await makeMap(campaignId, gmId);
    const sceneId = await makeScene(mapId);
    const tokenId = await makeBattleToken(sceneId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${tokenId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(tokenId);
      expect(await prisma.battleToken.findUnique({ where: { id: tokenId } })).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/tokens/:id is 404 for an unknown token', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
