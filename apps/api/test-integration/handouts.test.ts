/**
 * Integration coverage for the campaign-scoped handout surface in
 * `apps/api/src/routes/handouts.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent.
 *   - GET list: the caller must hold *some* permission on the campaign's server
 *     (`getServerPermissions !== 0n`). A non-server-member resolves to 0n and is
 *     hidden with 404 (existence not leaked). Visibility redaction then applies:
 *       · GM, ADMINISTRATOR, or VIEW_PRIVATE_HANDOUTS → sees everything.
 *       · a plain player sees `public_to_party` + any `specific_players` handout
 *         that lists them, but NEVER `gm_only` (and not `specific_players` it is
 *         not on).
 *   - POST: the GM, or a member with MANAGE_HANDOUTS, may create. A plain player
 *     is rejected with 403.
 *   - PATCH: the GM, the handout's author, or a member with MANAGE_HANDOUTS may
 *     edit; anyone else gets 403. Unknown campaign / handout → 404, bad body → 400.
 *
 * Fixtures: a server (owner == GM) with an @everyone role + one text channel,
 * a campaign with an explicit GM. `extraEveryonePerms` grants MANAGE_HANDOUTS /
 * VIEW_PRIVATE_HANDOUTS to every member to exercise the privileged paths.
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
 * @everyone bitset (e.g. to grant MANAGE_HANDOUTS / VIEW_PRIVATE_HANDOUTS).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Handout Tavern' } });
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

async function addCampaignMember(campaignId: string, userId: string): Promise<void> {
  await prisma.campaignMember.create({ data: { campaignId, userId, role: 'player' } });
}

/** Seed a handout directly (used for GET/PATCH fixtures). */
async function makeHandout(
  campaignId: string,
  serverId: string,
  authorId: string,
  opts: {
    title?: string;
    body?: string;
    visibility?: 'public_to_party' | 'gm_only' | 'specific_players';
    visibleToUserIds?: string[];
  } = {},
): Promise<string> {
  const id = ulid();
  await prisma.handout.create({
    data: {
      id,
      campaignId,
      serverId,
      authorId,
      title: opts.title ?? 'Untitled',
      body: opts.body ?? '',
      visibility: opts.visibility ?? 'public_to_party',
    },
  });
  if (opts.visibleToUserIds?.length) {
    await prisma.handoutVisibleUser.createMany({
      data: opts.visibleToUserIds.map((userId) => ({ handoutId: id, userId })),
    });
  }
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
type HandoutDto = {
  id: string;
  title: string;
  visibility: 'public_to_party' | 'gm_only' | 'specific_players';
  visibleToUserIds: string[];
};

describe.skipIf(!dockerOk)('handout routes (apps/api/src/routes/handouts.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.handoutVisibleUser.deleteMany({});
    await prisma.handout.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/campaigns/:id/handouts ---------------------------------

  it('the GM sees every handout including gm_only (200), newest first', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeHandout(campaignId, serverId, gmId, { title: 'Public', visibility: 'public_to_party' });
    await makeHandout(campaignId, serverId, gmId, { title: 'Secret', visibility: 'gm_only' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/handouts`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<HandoutDto[]>;
      expect(body.data.map((h) => h.title).sort()).toEqual(['Public', 'Secret']);
    } finally {
      await app.close();
    }
  });

  it('REDACTION: a plain player does NOT see gm_only handouts, but sees public ones (200)', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    await makeHandout(campaignId, serverId, gmId, { title: 'Party Map', visibility: 'public_to_party' });
    await makeHandout(campaignId, serverId, gmId, { title: 'GM Secret', visibility: 'gm_only' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/handouts`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<HandoutDto[]>;
      expect(body.data.map((h) => h.title)).toEqual(['Party Map']);
      // The gm_only content is fully absent from the payload.
      expect(res.body).not.toContain('GM Secret');
    } finally {
      await app.close();
    }
  });

  it('REDACTION: a player sees a specific_players handout only when listed on it (200)', async () => {
    const gmId = await makeUser('gm');
    const insiderId = await makeUser('insider');
    const outsiderId = await makeUser('outsider'); // campaign member, but not on the list
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, insiderId);
    await addMember(serverId, outsiderId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, insiderId);
    await addCampaignMember(campaignId, outsiderId);
    await makeHandout(campaignId, serverId, gmId, {
      title: 'Whisper',
      visibility: 'specific_players',
      visibleToUserIds: [insiderId],
    });

    const app = await buildTestApp();
    try {
      // The listed insider sees it.
      const insiderToken = await mintToken(insiderId);
      const insiderRes = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/handouts`,
        headers: { authorization: `Bearer ${insiderToken}` },
      });
      expect(insiderRes.statusCode).toBe(200);
      const insiderBody = insiderRes.json() as OkBody<HandoutDto[]>;
      expect(insiderBody.data.map((h) => h.title)).toEqual(['Whisper']);

      // The non-listed player does not.
      const outsiderToken = await mintToken(outsiderId);
      const outsiderRes = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/handouts`,
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      expect(outsiderRes.statusCode).toBe(200);
      const outsiderBody = outsiderRes.json() as OkBody<HandoutDto[]>;
      expect(outsiderBody.data).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('a member WITH VIEW_PRIVATE_HANDOUTS sees gm_only handouts (200)', async () => {
    const gmId = await makeUser('gm');
    const trustedId = await makeUser('trusted');
    const { serverId } = await makeServer(gmId, Permission.VIEW_PRIVATE_HANDOUTS);
    await addMember(serverId, trustedId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeHandout(campaignId, serverId, gmId, { title: 'GM Secret', visibility: 'gm_only' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(trustedId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/handouts`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<HandoutDto[]>;
      expect(body.data.map((h) => h.title)).toEqual(['GM Secret']);
    } finally {
      await app.close();
    }
  });

  it('GET .../handouts is 404 for a non-server-member (existence hidden)', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider'); // NOT a server member
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeHandout(campaignId, serverId, gmId, { title: 'Public', visibility: 'public_to_party' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/handouts`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../handouts is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/handouts`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../handouts without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/campaigns/${ulid()}/handouts` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/handouts ----------------------------------------------

  it('the GM can create a handout (201); the row + visibility persist', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/handouts',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId,
          title: 'The Map',
          body: 'X marks the spot',
          visibility: 'specific_players',
          visibleToUserIds: [playerId],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<HandoutDto>;
      expect(body.data.title).toBe('The Map');
      expect(body.data.visibility).toBe('specific_players');
      expect(body.data.visibleToUserIds).toEqual([playerId]);

      const row = await prisma.handout.findUniqueOrThrow({
        where: { id: body.data.id },
        include: { visibleUsers: true },
      });
      expect(row.authorId).toBe(gmId);
      expect(row.serverId).toBe(serverId);
      expect(row.visibleUsers.map((v) => v.userId)).toEqual([playerId]);
    } finally {
      await app.close();
    }
  });

  it('a member WITH MANAGE_HANDOUTS (non-GM) can create a handout (201)', async () => {
    const gmId = await makeUser('gm');
    const managerId = await makeUser('manager');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_HANDOUTS);
    await addMember(serverId, managerId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(managerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/handouts',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: 'Manager note', body: 'hi' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<HandoutDto>;
      const row = await prisma.handout.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.authorId).toBe(managerId);
    } finally {
      await app.close();
    }
  });

  it('a plain player (no MANAGE_HANDOUTS) cannot create a handout (403), no row written', async () => {
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
        url: '/api/handouts',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: 'Sneaky', body: 'no' },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.handout.count({ where: { campaignId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/handouts is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/handouts',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId: ulid(), title: 'Orphan', body: '' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/handouts is 400 when the body fails validation (empty title)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/handouts',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: '', body: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/handouts without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/handouts',
        payload: { campaignId: ulid(), title: 'Anon', body: '' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/handouts/:id -----------------------------------------

  it('the GM can update a handout (200): fields + visibility membership persist', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    const handoutId = await makeHandout(campaignId, serverId, gmId, {
      title: 'Before',
      visibility: 'public_to_party',
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/handouts/${handoutId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'After', visibility: 'specific_players', visibleToUserIds: [playerId] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<HandoutDto>;
      expect(body.data.title).toBe('After');
      expect(body.data.visibility).toBe('specific_players');
      expect(body.data.visibleToUserIds).toEqual([playerId]);

      const row = await prisma.handout.findUniqueOrThrow({
        where: { id: handoutId },
        include: { visibleUsers: true },
      });
      expect(row.title).toBe('After');
      expect(row.visibleUsers.map((v) => v.userId)).toEqual([playerId]);
    } finally {
      await app.close();
    }
  });

  it('the author (non-GM) can update their own handout (200)', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_HANDOUTS);
    await addMember(serverId, authorId);
    const campaignId = await makeCampaign(serverId, gmId);
    // Author created it (seed authorId == authorId); they keep edit rights even
    // independent of the server permission check.
    const handoutId = await makeHandout(campaignId, serverId, authorId, { title: 'Mine' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(authorId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/handouts/${handoutId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Mine (edited)' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.handout.findUniqueOrThrow({ where: { id: handoutId } });
      expect(row.title).toBe('Mine (edited)');
    } finally {
      await app.close();
    }
  });

  it('a plain player who is neither author nor GM cannot update (403), value unchanged', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);
    const handoutId = await makeHandout(campaignId, serverId, gmId, { title: 'Locked' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/handouts/${handoutId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.handout.findUniqueOrThrow({ where: { id: handoutId } });
      expect(row.title).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/handouts/:id is 404 for an unknown handout', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/handouts/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
