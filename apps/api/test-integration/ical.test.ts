/**
 * Integration coverage for the iCal subscription surface in
 * `apps/api/src/routes/ical.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Auth model (DUAL scheme):
 *   - Token management (`GET/POST/DELETE /api/me/ical-tokens`) is the normal
 *     Bearer-PAT session: `app.requireUser` → 401 without a token. Minting a
 *     kind=campaign token requires the caller to be a CampaignMember OR the
 *     campaign's GM (else 403); kind=campaign without campaignId → 400.
 *   - The public feed `GET /api/calendar/:kind/feed.ics` has NO session. The
 *     opaque `secretToken` passed as the `?token=` query param IS the auth.
 *     A missing/short token fails zod validation (400); an unknown, revoked,
 *     or kind-mismatched token → 404. A valid token returns 200 with a
 *     `text/calendar` body containing one VEVENT per scheduled session the
 *     token's owner can see.
 *
 * Federation is off so no route touches the outbound queue.
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

async function makeServer(ownerId: string): Promise<{ serverId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Calendar Tavern' } });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId };
}

async function makeCampaign(serverId: string, gmUserId: string, name = 'The Lost Mine'): Promise<string> {
  const id = ulid();
  await prisma.campaign.create({ data: { id, serverId, name, gmUserId } });
  return id;
}

async function addCampaignMember(campaignId: string, userId: string): Promise<void> {
  await prisma.campaignMember.create({ data: { campaignId, userId, role: 'player' } });
}

/** Seed a campaign session. `scheduledStart=null` means it is excluded from the feed. */
async function makeSession(
  campaignId: string,
  serverId: string,
  opts: {
    title?: string;
    description?: string | null;
    scheduledStart?: Date | null;
    scheduledEnd?: Date | null;
  } = {},
): Promise<string> {
  const id = ulid();
  await prisma.campaignSession.create({
    data: {
      id,
      campaignId,
      serverId,
      title: opts.title ?? 'Session Zero',
      description: opts.description ?? null,
      scheduledStart: opts.scheduledStart === undefined ? new Date('2026-06-01T18:00:00.000Z') : opts.scheduledStart,
      scheduledEnd: opts.scheduledEnd ?? null,
    },
  });
  return id;
}

/** Directly mint an ical token row, returning its opaque secret. */
async function makeIcalToken(
  userId: string,
  kind: 'all' | 'campaign',
  opts: { campaignId?: string | null; revoked?: boolean } = {},
): Promise<{ id: string; secretToken: string }> {
  const id = ulid();
  const secretToken = crypto.randomBytes(24).toString('base64url');
  await prisma.icalToken.create({
    data: {
      id,
      userId,
      kind,
      campaignId: opts.campaignId ?? null,
      secretToken,
      revokedAt: opts.revoked ? new Date() : null,
    },
  });
  return { id, secretToken };
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

describe.skipIf(!dockerOk)('ical routes (apps/api/src/routes/ical.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.icalToken.deleteMany({});
    await prisma.campaignSession.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- POST /api/me/ical-tokens ----------------------------------------

  it('mints an "all" feed token for the caller (201) and persists it', async () => {
    const userId = await makeUser('owner');
    await makeServer(userId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/ical-tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'all' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; kind: string; campaignId: string | null; secretToken: string }>;
      expect(body.data.kind).toBe('all');
      expect(body.data.campaignId).toBeNull();
      expect(body.data.secretToken.length).toBeGreaterThanOrEqual(8);

      const row = await prisma.icalToken.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.userId).toBe(userId);
      expect(row.secretToken).toBe(body.data.secretToken);
    } finally {
      await app.close();
    }
  });

  it('a GM can mint a kind=campaign token for their campaign (201)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/ical-tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'campaign', campaignId },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ kind: string; campaignId: string | null }>;
      expect(body.data.kind).toBe('campaign');
      expect(body.data.campaignId).toBe(campaignId);
    } finally {
      await app.close();
    }
  });

  it('a campaign member can mint a kind=campaign token (201)', async () => {
    const gmId = await makeUser('gm');
    const playerId = await makeUser('player');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    await addCampaignMember(campaignId, playerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/ical-tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'campaign', campaignId },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('a non-member cannot mint a kind=campaign token (403), no row written', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/ical-tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'campaign', campaignId },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.icalToken.count({ where: { userId: outsiderId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/ical-tokens is 400 for kind=campaign without campaignId', async () => {
    const userId = await makeUser('owner');
    await makeServer(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/ical-tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'campaign' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/ical-tokens without a session token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/ical-tokens',
        payload: { kind: 'all' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/me/ical-tokens -----------------------------------------

  it('lists the caller’s active tokens (200), excluding revoked ones', async () => {
    const userId = await makeUser('owner');
    await makeServer(userId);
    const live = await makeIcalToken(userId, 'all');
    await makeIcalToken(userId, 'all', { revoked: true });

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/ical-tokens',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string }>>;
      expect(body.data.map((t) => t.id)).toEqual([live.id]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/ical-tokens without a session token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/ical-tokens' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/me/ical-tokens/:id ----------------------------------

  it('revokes the caller’s own token (200): revokedAt is stamped, row not deleted', async () => {
    const userId = await makeUser('owner');
    await makeServer(userId);
    const { id } = await makeIcalToken(userId, 'all');

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/ical-tokens/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.icalToken.findUniqueOrThrow({ where: { id } });
      expect(row.revokedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('cannot revoke another user’s token (404), and the row is untouched', async () => {
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    await makeServer(ownerId);
    const { id } = await makeIcalToken(ownerId, 'all');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/ical-tokens/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      const row = await prisma.icalToken.findUniqueOrThrow({ where: { id } });
      expect(row.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/calendar/:kind/feed.ics (PUBLIC, token in query) -------

  it('a valid "all" token returns a text/calendar feed (200) with one VEVENT per scheduled session', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId, 'Curse of Strahd');
    await makeSession(campaignId, serverId, {
      title: 'The Death House',
      description: 'Spooky; watch out',
      scheduledStart: new Date('2026-06-01T18:00:00.000Z'),
      scheduledEnd: new Date('2026-06-01T22:00:00.000Z'),
    });
    // Unscheduled session must NOT appear.
    await makeSession(campaignId, serverId, { title: 'Unscheduled', scheduledStart: null });
    const { secretToken } = await makeIcalToken(gmId, 'all');

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/all/feed.ics?token=${secretToken}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/calendar');
      const ics = res.body;
      // ICS envelope.
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('VERSION:2.0');
      expect(ics).toContain('END:VCALENDAR');
      // Exactly one event (the scheduled one); the unscheduled one is filtered.
      const eventCount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
      expect(eventCount).toBe(1);
      // SUMMARY combines campaign name + session title.
      expect(ics).toContain('SUMMARY:Curse of Strahd: The Death House');
      expect(ics).toContain('DESCRIPTION:Spooky');
      // DTSTART derived from scheduledStart (UTC, no separators).
      expect(ics).toContain('DTSTART:20260601T180000Z');
      expect(ics).toContain('DTEND:20260601T220000Z');
      // CRLF line endings per RFC 5545.
      expect(ics).toContain('\r\n');
    } finally {
      await app.close();
    }
  });

  it('a kind=campaign token only includes its own campaign’s sessions (200)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const a = await makeCampaign(serverId, gmId, 'Campaign A');
    const b = await makeCampaign(serverId, gmId, 'Campaign B');
    await makeSession(a, serverId, { title: 'A Session' });
    await makeSession(b, serverId, { title: 'B Session' });
    const { secretToken } = await makeIcalToken(gmId, 'campaign', { campaignId: a });

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/campaign/feed.ics?token=${secretToken}`,
      });
      expect(res.statusCode).toBe(200);
      const ics = res.body;
      expect(ics).toContain('Campaign A: A Session');
      expect(ics).not.toContain('Campaign B: B Session');
      expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('an unknown token is 404', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/all/feed.ics?token=${'z'.repeat(32)}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a revoked token is 404', async () => {
    const userId = await makeUser('owner');
    await makeServer(userId);
    const { secretToken } = await makeIcalToken(userId, 'all', { revoked: true });

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/all/feed.ics?token=${secretToken}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a token whose kind does not match the path is 404 (campaign token on the /all feed)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const { secretToken } = await makeIcalToken(gmId, 'campaign', { campaignId });

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/all/feed.ics?token=${secretToken}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a missing token query param is 400 (zod validation)', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/calendar/all/feed.ics` });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('a too-short token query param is 400 (min(8))', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/calendar/all/feed.ics?token=short` });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
