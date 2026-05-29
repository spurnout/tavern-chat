/**
 * Integration coverage for the NPC roster surface in
 * `apps/api/src/routes/npcs.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * NPCs are CAMPAIGN-scoped. Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent.
 *   - GET /api/campaigns/:id/npcs → any CampaignMember may view; otherwise the
 *     route falls back to `loadCampaignContext` (GM, or server MANAGE_CAMPAIGNS).
 *     A plain server member who is not in the campaign and lacks
 *     MANAGE_CAMPAIGNS is rejected with 403.
 *   - POST /api/campaigns/:id/npcs, PATCH /api/npcs/:id, DELETE /api/npcs/:id,
 *     POST /api/campaigns/:id/npcs/generate → `loadCampaignContext`: the
 *     campaign GM, OR server MANAGE_CAMPAIGNS. A plain campaign *player* (no
 *     MANAGE_CAMPAIGNS) is therefore 403 for writes — only the GM/admin mutate.
 *   - missing campaign / NPC → 404, bad body → 400.
 *
 * Fixtures mirror characters.test.ts: a server (owner == GM) with an
 * @everyone role, one text channel, a campaign with an explicit GM, and an
 * optional CampaignMember "player". Federation is off so no route touches the
 * outbound queue.
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
 * A server owned by `ownerId` with an @everyone role + one text channel and
 * the owner as a member. `extraEveryonePerms` is OR-ed onto the default
 * @everyone bitset (e.g. to grant MANAGE_CAMPAIGNS to every member).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'NPC Tavern' } });
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
async function addCampaignMember(
  campaignId: string,
  userId: string,
  role: 'player' | 'co_gm' = 'player',
): Promise<void> {
  await prisma.campaignMember.create({ data: { campaignId, userId, role } });
}

/** Seed an NPC directly (used to seed PATCH/DELETE/GET fixtures). */
async function makeNpc(campaignId: string, createdBy: string, name = 'Strahd'): Promise<string> {
  const id = ulid();
  await prisma.npc.create({
    data: {
      id,
      campaignId,
      name,
      descriptionMd: null,
      statBlockJson: {},
      isAlive: true,
      createdBy,
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
type NpcDto = {
  id: string;
  campaignId: string;
  name: string;
  descriptionMd: string | null;
  factionTag: string | null;
  isAlive: boolean;
  createdBy: string;
};

describe.skipIf(!dockerOk)('NPC roster routes (apps/api/src/routes/npcs.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.npc.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/campaigns/:id/npcs ------------------------------------

  it('lists campaign NPCs for a member, ordered by name asc', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    await makeNpc(campaignId, gmId, 'Zorath');
    await makeNpc(campaignId, gmId, 'Auriel');

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/npcs`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<NpcDto[]>;
      expect(body.data.map((n) => n.name)).toEqual(['Auriel', 'Zorath']);
      expect(body.data.every((n) => n.campaignId === campaignId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET .../npcs is 403 for a server member who is not in the campaign (no MANAGE_CAMPAIGNS)', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, outsiderId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeNpc(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/npcs`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET .../npcs is 404 for an unknown campaign (non-member path → loadCampaignContext)', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/npcs`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../npcs without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/campaigns/${ulid()}/npcs` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/campaigns/:id/npcs -----------------------------------

  it('the GM can create an NPC (201) owned by the caller; fields persist', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/npcs`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Volo',
          descriptionMd: 'A famous (and verbose) chronicler.',
          factionTag: 'Lords Alliance',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<NpcDto>;
      expect(body.data.name).toBe('Volo');
      expect(body.data.campaignId).toBe(campaignId);
      expect(body.data.createdBy).toBe(gmId);
      expect(body.data.factionTag).toBe('Lords Alliance');

      const row = await prisma.npc.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.createdBy).toBe(gmId);
      expect(row.descriptionMd).toBe('A famous (and verbose) chronicler.');
    } finally {
      await app.close();
    }
  });

  it('a server member WITH MANAGE_CAMPAIGNS (not GM, not a member) can create an NPC (201)', async () => {
    const gmId = await makeUser('gm');
    const adminId = await makeUser('admin');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGNS);
    await addMember(serverId, adminId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(adminId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/npcs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Admin NPC' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<NpcDto>;
      expect(body.data.createdBy).toBe(adminId);
    } finally {
      await app.close();
    }
  });

  it('a campaign player (no MANAGE_CAMPAIGNS) cannot create an NPC (403), no row written', async () => {
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
        url: `/api/campaigns/${campaignId}/npcs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Player NPC' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.npc.count({ where: { campaignId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST .../npcs is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${ulid()}/npcs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Orphan' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST .../npcs is 400 when the body fails validation (empty name)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/npcs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/npcs/:id ---------------------------------------------

  it('the GM can update an NPC (200) and changes persist', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const npcId = await makeNpc(campaignId, gmId, 'Before');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/npcs/${npcId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'After', isAlive: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<NpcDto>;
      expect(body.data.name).toBe('After');
      expect(body.data.isAlive).toBe(false);

      const row = await prisma.npc.findUniqueOrThrow({ where: { id: npcId } });
      expect(row.name).toBe('After');
      expect(row.isAlive).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('a campaign player (no MANAGE_CAMPAIGNS) cannot update an NPC (403), value unchanged', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const npcId = await makeNpc(campaignId, gmId, 'Locked');

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/npcs/${npcId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.npc.findUniqueOrThrow({ where: { id: npcId } });
      expect(row.name).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/npcs/:id is 404 for an unknown NPC', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/npcs/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/npcs/:id --------------------------------------------

  it('the GM can delete an NPC (200) and the row is gone', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const npcId = await makeNpc(campaignId, gmId, 'Doomed');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/npcs/${npcId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(npcId);
      const row = await prisma.npc.findUnique({ where: { id: npcId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a campaign player (no MANAGE_CAMPAIGNS) cannot delete an NPC (403), row survives', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const npcId = await makeNpc(campaignId, gmId, 'Survivor');

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/npcs/${npcId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.npc.findUnique({ where: { id: npcId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/npcs/:id is 404 for an unknown NPC', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/npcs/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/campaigns/:id/npcs/generate --------------------------

  it('the GM can generate an NPC without persisting (200): generated payload, no row', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/npcs/generate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { seed: 42 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ generated: { name: string }; persisted: unknown }>;
      expect(typeof body.data.generated.name).toBe('string');
      expect(body.data.persisted).toBeNull();
      expect(await prisma.npc.count({ where: { campaignId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('the GM can generate AND persist an NPC (201): a row is written', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/npcs/generate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { seed: 7, persist: true },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ generated: { name: string }; persisted: { id: string } }>;
      expect(body.data.persisted).not.toBeNull();
      const row = await prisma.npc.findUniqueOrThrow({ where: { id: body.data.persisted.id } });
      expect(row.campaignId).toBe(campaignId);
      expect(row.createdBy).toBe(gmId);
      expect(await prisma.npc.count({ where: { campaignId } })).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('a campaign player (no MANAGE_CAMPAIGNS) cannot generate an NPC (403)', async () => {
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
        url: `/api/campaigns/${campaignId}/npcs/generate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { persist: true },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST .../npcs/generate is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${ulid()}/npcs/generate`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
