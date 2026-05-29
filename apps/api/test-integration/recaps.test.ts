/**
 * Integration coverage for the campaign-scoped session recap surface in
 * `apps/api/src/routes/recaps.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - GET /api/campaigns/:id/recaps: any server member (perms !== 0n) can list
 *   - POST /api/campaigns/:id/recaps: GM (gmUserId === caller) or VIEW_GM_NOTES; 503 if LLM not configured
 *   - PATCH /api/recaps/:id: generatedBy user, campaign GM, or VIEW_GM_NOTES
 *   - DELETE /api/recaps/:id: same as PATCH
 *   - unknown campaign / recap → 404, bad body → 400
 *
 * For POST, the test mocks the global `fetch` to simulate the LLM endpoint
 * returning a valid response. The 503 branch is tested by omitting LLM_ENDPOINT.
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
 * @everyone bitset.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Recap Tavern' } });
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

/** Directly insert a SessionRecap row (used to seed PATCH/DELETE/GET fixtures). */
async function makeRecap(
  campaignId: string,
  generatedBy: string,
  body = 'The heroes fought bravely and discovered the secret passage.',
): Promise<string> {
  const id = ulid();
  await prisma.sessionRecap.create({
    data: {
      id,
      campaignId,
      body,
      modelUsed: 'gpt-4o-mini',
      generatedBy,
    },
  });
  return id;
}

function envFor(dbUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    ...extra,
  } as NodeJS.ProcessEnv;
}

async function buildTestApp(extra: Record<string, string> = {}) {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envFor(ctx!.databaseUrl, extra)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

type OkBody<T> = { ok: true; data: T };

/** Build a mock fetch that returns a standard OpenAI-shaped response. */
function mockLlmFetch(recapText = 'Session recap: the party succeeded.') {
  return vi.fn(async (_url: unknown, _init: unknown) =>
    new Response(
      JSON.stringify({
        model: 'gpt-4o-mini',
        choices: [{ message: { content: recapText } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe.skipIf(!dockerOk)('recap routes (apps/api/src/routes/recaps.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    vi.restoreAllMocks();
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

  // ---- GET /api/campaigns/:id/recaps ----------------------------------------

  it('lists recaps for a server member ordered newest first (200)', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);
    const id1 = await makeRecap(campaignId, gmId, 'Session 1 recap');
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await makeRecap(campaignId, gmId, 'Session 2 recap');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<
        Array<{ id: string; campaignId: string; body: string; modelUsed: string; generatedBy: string; createdAt: string }>
      >;
      expect(body.ok).toBe(true);
      expect(body.data.length).toBe(2);
      // newest first
      expect(body.data[0]?.id).toBe(id2);
      expect(body.data[1]?.id).toBe(id1);
      expect(body.data.every((r) => r.campaignId === campaignId)).toBe(true);
      // shape check
      expect(typeof body.data[0]?.createdAt).toBe('string');
      expect(body.data[0]?.modelUsed).toBe('gpt-4o-mini');
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/recaps returns empty array when no recaps exist', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/recaps is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/recaps`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/recaps is 404 when caller is not a member of the server', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    // outsider NOT added to server
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
      });
      // perms === 0n → notFound
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/recaps is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/recaps`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/campaigns/:id/recaps (LLM not configured) ------------------

  it('POST /api/campaigns/:id/recaps returns 503 when LLM_ENDPOINT is not set', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    // Build app WITHOUT LLM_ENDPOINT — recap service is disabled
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { transcript: 'The heroes entered the dungeon and battled the goblin horde.' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('POST /api/campaigns/:id/recaps is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${ulid()}/recaps`,
        payload: { transcript: 'A long enough transcript here to pass validation checks.' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/campaigns/:id/recaps is 403 when caller is not GM and lacks VIEW_GM_NOTES', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    // default @everyone does NOT include VIEW_GM_NOTES
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { transcript: 'A long enough transcript here to pass validation checks.' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST /api/campaigns/:id/recaps is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${ulid()}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { transcript: 'A long enough transcript here to pass validation checks.' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/campaigns/:id/recaps is 400 when transcript is too short (< 20 chars)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp({ LLM_ENDPOINT: 'http://localhost:11434/v1' });
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { transcript: 'too short' }, // < 20 chars → zod min(20) fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/campaigns/:id/recaps is 400 when body is empty (no transcript, no sessionId)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp({ LLM_ENDPOINT: 'http://localhost:11434/v1' });
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // no transcript, no sessionId → route throws VALIDATION_ERROR
      });
      // Route checks transcript after zod parse; empty/undefined transcript → 400
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GM can generate a recap when LLM is configured (201), row persisted', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const recapText = 'The party bravely entered the dungeon and defeated the dragon king.';
    vi.stubGlobal('fetch', mockLlmFetch(recapText));

    const app = await buildTestApp({ LLM_ENDPOINT: 'http://localhost:11434/v1' });
    try {
      const token = await mintToken(gmId);
      const transcript =
        'Aldric the warrior charged into the dungeon. ' +
        'Mira the mage cast fireball. The dragon king fell.';
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { transcript },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        campaignId: string;
        body: string;
        modelUsed: string;
        generatedBy: string;
        sessionId: string | null;
        createdAt: string;
      }>;
      expect(body.data.body).toBe(recapText);
      expect(body.data.campaignId).toBe(campaignId);
      expect(body.data.generatedBy).toBe(gmId);
      expect(body.data.modelUsed).toBe('gpt-4o-mini');
      expect(body.data.sessionId).toBeNull();
      expect(typeof body.data.createdAt).toBe('string');

      // DB state
      const row = await prisma.sessionRecap.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.campaignId).toBe(campaignId);
      expect(row.generatedBy).toBe(gmId);
      expect(row.body).toBe(recapText);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('a member with VIEW_GM_NOTES can generate a recap (201)', async () => {
    const gmId = await makeUser('gm');
    const noteReaderId = await makeUser('reader');
    const { serverId } = await makeServer(gmId, Permission.VIEW_GM_NOTES);
    await addMember(serverId, noteReaderId);
    const campaignId = await makeCampaign(serverId, gmId);

    const recapText = 'Notable events occurred during this session.';
    vi.stubGlobal('fetch', mockLlmFetch(recapText));

    const app = await buildTestApp({ LLM_ENDPOINT: 'http://localhost:11434/v1' });
    try {
      const token = await mintToken(noteReaderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/recaps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { transcript: 'The session was full of adventure and excitement.' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ generatedBy: string }>;
      expect(body.data.generatedBy).toBe(noteReaderId);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  // ---- PATCH /api/recaps/:id -------------------------------------------------

  it('the recap author can update the body (200) and changes persist', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, gmId, 'Original recap body.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'Updated recap body with more detail.' },
      });
      expect(res.statusCode).toBe(200);
      const result = res.json() as OkBody<{ id: string; body: string }>;
      expect(result.data.body).toBe('Updated recap body with more detail.');
      expect(result.data.id).toBe(recapId);

      const row = await prisma.sessionRecap.findUniqueOrThrow({ where: { id: recapId } });
      expect(row.body).toBe('Updated recap body with more detail.');
    } finally {
      await app.close();
    }
  });

  it('the campaign GM can update a recap generated by someone else (200)', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const { serverId } = await makeServer(gmId, Permission.VIEW_GM_NOTES);
    await addMember(serverId, authorId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, authorId, 'Author wrote this.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'GM edited this recap.' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.sessionRecap.findUniqueOrThrow({ where: { id: recapId } });
      expect(row.body).toBe('GM edited this recap.');
    } finally {
      await app.close();
    }
  });

  it('a server member with VIEW_GM_NOTES can update any recap (200)', async () => {
    const gmId = await makeUser('gm');
    const adminId = await makeUser('admin');
    const { serverId } = await makeServer(gmId, Permission.VIEW_GM_NOTES);
    await addMember(serverId, adminId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, gmId, 'GM wrote this.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(adminId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'Admin edited this recap.' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a plain member (not author, not GM, lacks VIEW_GM_NOTES) cannot update (403), value unchanged', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, authorId);
    await addMember(serverId, otherId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, authorId, 'Protected recap.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'Hijacked recap.' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.sessionRecap.findUniqueOrThrow({ where: { id: recapId } });
      expect(row.body).toBe('Protected recap.');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/recaps/:id is 404 for an unknown recap', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'Does not matter.' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/recaps/:id is 400 when body is empty string', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: '' }, // min(1) → zod fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/recaps/:id is 400 when body field is missing', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // body field missing → zod fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/recaps/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recaps/${ulid()}`,
        payload: { body: 'Edited.' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/recaps/:id ------------------------------------------------

  it('the recap author can delete their recap (200) and the row is gone', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, gmId, 'Doomed recap.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(recapId);

      const row = await prisma.sessionRecap.findUnique({ where: { id: recapId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('the campaign GM can delete a recap generated by someone else (200)', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const { serverId } = await makeServer(gmId, Permission.VIEW_GM_NOTES);
    await addMember(serverId, authorId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, authorId, 'Author recap to delete.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.sessionRecap.findUnique({ where: { id: recapId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a plain member (not author, not GM, lacks VIEW_GM_NOTES) cannot delete (403), row survives', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, authorId);
    await addMember(serverId, otherId);
    const campaignId = await makeCampaign(serverId, gmId);
    const recapId = await makeRecap(campaignId, authorId, 'Survivor recap.');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recaps/${recapId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.sessionRecap.findUnique({ where: { id: recapId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/recaps/:id is 404 for an unknown recap', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recaps/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/recaps/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recaps/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
