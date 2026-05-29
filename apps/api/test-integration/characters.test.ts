/**
 * Integration coverage for the campaign-scoped character surface in
 * `apps/api/src/routes/characters.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode (via `ensureCampaignMember`):
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - the caller must be a CampaignMember OR the campaign's GM; otherwise the
 *     route falls back to server MANAGE_CAMPAIGNS (admins read/manage). A plain
 *     outsider with only the default @everyone bitset is rejected with 403
 *     ("You are not in this campaign").
 *   - create: any campaign member (or GM) may create a character; `ownerUserId`
 *     is always the caller — there is no ownership transfer.
 *   - patch / delete: only the character's owner OR the GM may mutate it;
 *     anyone else in the campaign gets 403.
 *   - missing campaign / character → 404, bad body → 400.
 *
 * Fixtures: a server (owner == GM) with an @everyone role, one text channel,
 * a campaign with an explicit GM, plus a CampaignMember "player". Federation
 * is off so no route touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, serializePermissions, ulid } from '@tavern/shared';
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
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Character Tavern' } });
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
  await prisma.campaign.create({
    data: { id, serverId, name: 'The Lost Mine', gmUserId },
  });
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

/** Create a character directly (used to seed PATCH/DELETE/GET fixtures). */
async function makeCharacter(
  campaignId: string,
  ownerUserId: string,
  name = 'Tordek',
): Promise<string> {
  const id = ulid();
  await prisma.character.create({
    data: {
      id,
      campaignId,
      ownerUserId,
      name,
      system: 'generic',
      sheetJson: {},
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

describe.skipIf(!dockerOk)('campaign-character routes (apps/api/src/routes/characters.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.characterMacro.deleteMany({});
    await prisma.character.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- POST /api/campaigns/:id/characters -----------------------------

  it('the GM can create a character (201) owned by the caller, with a defaulted sheet', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/characters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Mordenkainen', conceptOneLiner: 'arch-mage', system: 'dnd5e' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        campaignId: string;
        ownerUserId: string;
        name: string;
        system: string;
      }>;
      expect(body.data.name).toBe('Mordenkainen');
      expect(body.data.campaignId).toBe(campaignId);
      expect(body.data.ownerUserId).toBe(gmId);
      expect(body.data.system).toBe('dnd5e');

      const row = await prisma.character.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.ownerUserId).toBe(gmId);
      expect(row.conceptOneLiner).toBe('arch-mage');
      // dnd5e sheet is validated + defaulted server-side.
      expect((row.sheetJson as { level: number }).level).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('a campaign member (player) can create their own character (201, owned by them)', async () => {
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
        url: `/api/campaigns/${campaignId}/characters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Lidda', system: 'generic' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; ownerUserId: string }>;
      expect(body.data.ownerUserId).toBe(playerId);
    } finally {
      await app.close();
    }
  });

  it('a non-member (no MANAGE_CAMPAIGNS) cannot create a character (403), no row written', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, outsiderId); // server member, NOT a campaign member
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/characters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Trespasser' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.character.count({ where: { campaignId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST .../characters is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${ulid()}/characters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Orphan' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST .../characters is 400 when the body fails validation (empty name)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/characters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '' }, // min(1) → zod fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST .../characters without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${ulid()}/characters`,
        payload: { name: 'Nobody' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/campaigns/:id/characters ------------------------------

  it('lists campaign characters for a member, ordered by name asc', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    await makeCharacter(campaignId, gmId, 'Zara');
    await makeCharacter(campaignId, playerId, 'Aric');

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/characters`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ name: string; campaignId: string }>>;
      expect(body.data.map((c) => c.name)).toEqual(['Aric', 'Zara']);
      expect(body.data.every((c) => c.campaignId === campaignId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET .../characters is 403 for a non-member', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, outsiderId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeCharacter(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/characters`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/characters/:id ----------------------------------------

  it('returns a single character to a campaign member (200)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const charId = await makeCharacter(campaignId, gmId, 'Solo');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; name: string }>;
      expect(body.data.id).toBe(charId);
      expect(body.data.name).toBe('Solo');
    } finally {
      await app.close();
    }
  });

  it('GET /api/characters/:id is 404 for an unknown character', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/characters/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/characters/:id is 403 when the character belongs to a campaign the caller is not in', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, outsiderId);
    const campaignId = await makeCampaign(serverId, gmId);
    const charId = await makeCharacter(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/characters/:id --------------------------------------

  it('the owner can update their character (200) and changes persist', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const charId = await makeCharacter(campaignId, playerId, 'Before');

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'After', conceptOneLiner: 'reforged' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string; conceptOneLiner: string | null }>;
      expect(body.data.name).toBe('After');
      expect(body.data.conceptOneLiner).toBe('reforged');

      const row = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
      expect(row.name).toBe('After');
    } finally {
      await app.close();
    }
  });

  it('the GM can update a character owned by someone else (200)', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const charId = await makeCharacter(campaignId, playerId, 'PlayerPC');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'GM Renamed' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
      expect(row.name).toBe('GM Renamed');
    } finally {
      await app.close();
    }
  });

  it('a campaign member who is neither owner nor GM cannot update (403), value unchanged', async () => {
    const gmId = await makeUser('gm');
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, ownerId);
    await addMember(serverId, otherId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, ownerId);
    await addCampaignMember(campaignId, otherId);
    const charId = await makeCharacter(campaignId, ownerId, 'Locked');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
      expect(row.name).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/characters/:id is 404 for an unknown character', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/characters/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/characters/:id -------------------------------------

  it('the GM can delete any character (200) and the row is gone', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const charId = await makeCharacter(campaignId, playerId, 'Doomed');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(charId);

      const row = await prisma.character.findUnique({ where: { id: charId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a non-owner non-GM member cannot delete (403), the row survives', async () => {
    const gmId = await makeUser('gm');
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, ownerId);
    await addMember(serverId, otherId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, ownerId);
    await addCampaignMember(campaignId, otherId);
    const charId = await makeCharacter(campaignId, ownerId, 'Survivor');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/characters/${charId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.character.findUnique({ where: { id: charId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/characters/:id is 404 for an unknown character', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/characters/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
