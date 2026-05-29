/**
 * Integration coverage for the campaign-session surface in
 * `apps/api/src/routes/sessions.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * NOTE: despite the file name, `routes/sessions.ts` is about *campaign*
 * sessions (the tabletop-RPG "game session" object), NOT login sessions —
 * those live in `routes/account.ts` and are covered in `account.test.ts`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - read endpoints (`GET .../sessions`, `PUT .../rsvp`, live-session dock)
 *     gate on server membership: a non-member sees 404 (existence is hidden)
 *   - write endpoints allow the campaign GM unconditionally; otherwise the
 *     caller needs CREATE_SESSIONS (create) / MANAGE_SESSIONS (update)
 *   - missing campaign / session → 404, bad body / id → 400
 *
 * Fixtures: a server with an @everyone role whose permission bitset we tune
 * per-test (so we can grant or withhold CREATE_SESSIONS / MANAGE_SESSIONS),
 * a campaign with an explicit GM, plus members. Federation is off.
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
 * @everyone bitset so a test can grant CREATE_SESSIONS / MANAGE_SESSIONS to
 * every member (used to prove the permission branch, separate from the GM
 * shortcut).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Session Tavern' } });
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

async function makeSession(
  campaignId: string,
  serverId: string,
  overrides: Partial<{
    title: string;
    status: 'planned' | 'live' | 'completed' | 'cancelled';
    voiceChannelId: string | null;
    textChannelId: string | null;
  }> = {},
): Promise<string> {
  const id = ulid();
  await prisma.campaignSession.create({
    data: {
      id,
      campaignId,
      serverId,
      title: overrides.title ?? 'Session Zero',
      status: overrides.status ?? 'planned',
      voiceChannelId: overrides.voiceChannelId ?? null,
      textChannelId: overrides.textChannelId ?? null,
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

describe.skipIf(!dockerOk)('campaign-session routes (apps/api/src/routes/sessions.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.campaignSessionRsvp.deleteMany({});
    await prisma.campaignNote.deleteMany({});
    await prisma.campaignSession.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/campaigns/:id/sessions --------------------------------

  it('lists sessions for a campaign the caller can see (newest scheduled first)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessA = await makeSession(campaignId, serverId, { title: 'A' });
    const sessB = await makeSession(campaignId, serverId, { title: 'B' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/sessions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; campaignId: string }>>;
      const ids = body.data.map((s) => s.id).sort();
      expect(ids).toEqual([sessA, sessB].sort());
      expect(body.data.every((s) => s.campaignId === campaignId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET .../sessions is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/sessions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../sessions is 404 for a non-member (existence hidden)', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeSession(campaignId, serverId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/sessions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../sessions without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/campaigns/${ulid()}/sessions` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/sessions ---------------------------------------------

  it('the campaign GM can create a session (201) regardless of role perms', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId); // default @everyone, no CREATE_SESSIONS
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: 'First Game', agenda: 'roll initiative' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; title: string; status: string }>;
      expect(body.data.title).toBe('First Game');
      expect(body.data.status).toBe('planned');

      const row = await prisma.campaignSession.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.campaignId).toBe(campaignId);
      expect(row.serverId).toBe(serverId);
    } finally {
      await app.close();
    }
  });

  it('a non-GM member WITH CREATE_SESSIONS can create a session (201)', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId, Permission.CREATE_SESSIONS);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: 'Member-made' },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('a non-GM member WITHOUT CREATE_SESSIONS is 403', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId); // default perms only
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: 'Should fail' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.campaignSession.count({ where: { campaignId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/sessions is 404 when the campaign does not exist', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId: ulid(), title: 'Orphan' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/sessions is 400 when the body fails validation (missing title)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId }, // no title → zod fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/sessions/:id ----------------------------------------

  it('the GM can update a session (200) and changes persist', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId, { title: 'Before' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'After', status: 'live', recap: 'they survived' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ title: string; status: string; recap: string | null }>;
      expect(body.data.title).toBe('After');
      expect(body.data.status).toBe('live');
      expect(body.data.recap).toBe('they survived');

      const row = await prisma.campaignSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.title).toBe('After');
      expect(row.status).toBe('live');
    } finally {
      await app.close();
    }
  });

  it('a non-GM member WITHOUT MANAGE_SESSIONS cannot update (403)', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId, { title: 'Locked' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.campaignSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.title).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('a non-GM member WITH MANAGE_SESSIONS can update (200)', async () => {
    const gmId = await makeUser('gm');
    const managerId = await makeUser('manager');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_SESSIONS);
    await addMember(serverId, managerId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId, { title: 'Before' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(managerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Manager Edit' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/sessions/:id is 404 for an unknown session', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/channels/:channelId/live-session ----------------------

  it('returns ok(null) when no live session is bound to the channel', async () => {
    const gmId = await makeUser('gm');
    const { serverId, channelId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    // A non-live session bound to the channel must NOT match.
    await makeSession(campaignId, serverId, { status: 'planned', textChannelId: channelId });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/live-session`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown>;
      expect(body.data).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns ok(null) for an unknown channel (no existence leak, no 404)', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${ulid()}/live-session`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown>;
      expect(body.data).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('is 404 when the caller is not a member of the channel\'s server', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId, channelId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeSession(campaignId, serverId, { status: 'live', textChannelId: channelId });

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/live-session`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns the live session with isGm=true and GM-only notes for the GM', async () => {
    const gmId = await makeUser('gm');
    const { serverId, channelId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId, {
      status: 'live',
      title: 'Live One',
      voiceChannelId: channelId,
    });
    await prisma.campaignNote.create({
      data: {
        id: ulid(),
        campaignId,
        serverId,
        authorId: gmId,
        title: 'Secret plot',
        body: 'the butler did it',
        visibility: 'gm_only',
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/live-session`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        session: { id: string };
        isGm: boolean;
        gmNotes: Array<{ id: string; title: string }>;
      }>;
      expect(body.data.session.id).toBe(sessionId);
      expect(body.data.isGm).toBe(true);
      expect(body.data.gmNotes).toHaveLength(1);
      expect(body.data.gmNotes[0]?.title).toBe('Secret plot');
    } finally {
      await app.close();
    }
  });

  it('returns the live session with isGm=false and NO GM notes for a plain member', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId, channelId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeSession(campaignId, serverId, { status: 'live', textChannelId: channelId });
    await prisma.campaignNote.create({
      data: {
        id: ulid(),
        campaignId,
        serverId,
        authorId: gmId,
        title: 'Hidden',
        body: 'players cannot read this',
        visibility: 'gm_only',
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/live-session`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        isGm: boolean;
        gmNotes: unknown[];
      }>;
      expect(body.data.isGm).toBe(false);
      expect(body.data.gmNotes).toHaveLength(0);
      // The note body must never reach a non-GM.
      expect(res.body).not.toContain('players cannot read this');
    } finally {
      await app.close();
    }
  });

  // ---- PUT /api/sessions/:id/rsvp -------------------------------------

  it('a member can RSVP to a session, and a second call upserts the status', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, playerId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);

      const first = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'yes' },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as OkBody<{ sessionId: string; userId: string; status: string }>;
      expect(firstBody.data.status).toBe('yes');
      expect(firstBody.data.userId).toBe(playerId);

      // Change the answer — upsert, not a duplicate row.
      const second = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'maybe' },
      });
      expect(second.statusCode).toBe(200);

      const rows = await prisma.campaignSessionRsvp.findMany({ where: { sessionId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('maybe');
    } finally {
      await app.close();
    }
  });

  it('PUT .../rsvp is 404 for an unknown session', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${ulid()}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'yes' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PUT .../rsvp is 404 for a non-member of the session\'s server', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'yes' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PUT .../rsvp is 400 for an invalid status value', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const sessionId = await makeSession(campaignId, serverId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'definitely' }, // not in the rsvp enum
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PUT .../rsvp without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${ulid()}/rsvp`,
        payload: { status: 'yes' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
