/**
 * Integration coverage for the campaign-scoped calendar surface in
 * `apps/api/src/routes/campaign-calendar.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode (via `loadCtx`):
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - the caller must be either the GM, a CampaignMember, or hold
 *     server MANAGE_CAMPAIGNS; a server member who is none of those
 *     gets 403 from `requireServerPermission`.
 *   - non-members who are not on the server at all are also 403 (not 404)
 *     because the campaign is found, just the caller lacks access.
 *   - GET /api/campaigns/:id/calendar: any authorised caller (GM or member) reads
 *   - PUT /api/campaigns/:id/calendar: GM only; members → 403
 *   - POST /api/campaigns/:id/calendar/entries: GM only; if no calendar → 400
 *   - DELETE /api/calendar-entries/:id: GM only; members → 403
 *   - unknown campaign / entry → 404, bad body → 400
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
import {
  isDockerAvailable,
  resetDb,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';

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

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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
 * A server owned by `ownerId` with an @everyone role + one text channel.
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Calendar Tavern' } });
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
  await prisma.campaign.create({ data: { id, serverId, name: 'Calendar Quest', gmUserId } });
  return id;
}

async function addCampaignMember(
  campaignId: string,
  userId: string,
  role: 'player' | 'co_gm' = 'player',
): Promise<void> {
  await prisma.campaignMember.create({ data: { campaignId, userId, role } });
}

/** Create an InWorldCalendar row directly for use in entry tests. */
async function makeCalendar(campaignId: string): Promise<string> {
  const id = ulid();
  await prisma.inWorldCalendar.create({
    data: { id, campaignId, system: 'gregorian', currentDate: '0001-01-01' },
  });
  return id;
}

/** Create a TimelineEntry directly. */
async function makeEntry(calendarId: string, createdBy: string): Promise<string> {
  const id = ulid();
  await prisma.timelineEntry.create({
    data: { id, calendarId, inWorldDate: '0001-01-15', title: 'Existing Event', createdBy },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)(
  'campaign-calendar routes (apps/api/src/routes/campaign-calendar.ts)',
  () => {
    beforeEach(async () => {
      if (!dockerOk) return;
      await resetDb(prisma);
    });

    // ---- GET /api/campaigns/:id/calendar ------------------------------------

    it('GET returns null when no calendar has been created yet (200)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<null>;
        expect(body.ok).toBe(true);
        expect(body.data).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('GET returns calendar with ordered entries for the GM', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      const calId = await makeCalendar(campaignId);
      // Insert two entries — expect alphabetical inWorldDate order ascending
      await prisma.timelineEntry.create({
        data: {
          id: ulid(),
          calendarId: calId,
          inWorldDate: '0001-03-01',
          title: 'Later Event',
          createdBy: gmId,
        },
      });
      await prisma.timelineEntry.create({
        data: {
          id: ulid(),
          calendarId: calId,
          inWorldDate: '0001-01-01',
          title: 'Earlier Event',
          createdBy: gmId,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          id: string;
          campaignId: string;
          system: string;
          entries: Array<{ title: string; inWorldDate: string }>;
        }>;
        expect(body.data?.campaignId).toBe(campaignId);
        expect(body.data?.system).toBe('gregorian');
        expect(body.data?.entries.map((e) => e.title)).toEqual(['Earlier Event', 'Later Event']);
      } finally {
        await app.close();
      }
    });

    it('GET returns calendar for a campaign member (player)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, playerId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(playerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ campaignId: string } | null>;
        expect(body.data?.campaignId).toBe(campaignId);
      } finally {
        await app.close();
      }
    });

    it('GET /api/campaigns/:id/calendar is 403 for a non-member server member', async () => {
      const gmId = await makeUser('gm');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, outsiderId); // server member, NOT a campaign member
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('GET /api/campaigns/:id/calendar is 200 for a member with MANAGE_CAMPAIGNS (non-campaign-member)', async () => {
      const gmId = await makeUser('gm');
      const adminId = await makeUser('admin');
      const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGNS);
      await addMember(serverId, adminId);
      const campaignId = await makeCampaign(serverId, gmId);
      // adminId is NOT in campaignMember but has MANAGE_CAMPAIGNS via @everyone

      const app = await buildTestApp();
      try {
        const token = await mintToken(adminId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('GET /api/campaigns/:id/calendar is 404 for an unknown campaign', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${ulid()}/calendar`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('GET /api/campaigns/:id/calendar without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${ulid()}/calendar`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- PUT /api/campaigns/:id/calendar ------------------------------------

    it('PUT creates the calendar (upsert) and returns it (200)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { system: 'forgotten_realms', currentDate: '1492-DR-1' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          campaignId: string;
          system: string;
          currentDate: string;
        }>;
        expect(body.data.campaignId).toBe(campaignId);
        expect(body.data.system).toBe('forgotten_realms');
        expect(body.data.currentDate).toBe('1492-DR-1');

        const row = await prisma.inWorldCalendar.findUnique({ where: { campaignId } });
        expect(row).not.toBeNull();
        expect(row?.system).toBe('forgotten_realms');
      } finally {
        await app.close();
      }
    });

    it('PUT updates an existing calendar (upsert) and persists changes', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { system: 'custom', currentDate: '5e-1492-3' },
        });
        expect(res.statusCode).toBe(200);
        const row = await prisma.inWorldCalendar.findUnique({ where: { campaignId } });
        expect(row?.system).toBe('custom');
        expect(row?.currentDate).toBe('5e-1492-3');
      } finally {
        await app.close();
      }
    });

    it('PUT uses default values when optional fields are omitted', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ system: string; currentDate: string }>;
        // schema defaults: system='gregorian', currentDate='0001-01-01'
        expect(body.data.system).toBe('gregorian');
        expect(body.data.currentDate).toBe('0001-01-01');
      } finally {
        await app.close();
      }
    });

    it('PUT is 403 for a campaign member (player) — only GM can mutate', async () => {
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
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { system: 'forgotten_realms' },
        });
        expect(res.statusCode).toBe(403);
        // No calendar should have been created
        const row = await prisma.inWorldCalendar.findUnique({ where: { campaignId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('PUT is 403 for a non-member server member', async () => {
      const gmId = await makeUser('gm');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, outsiderId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { system: 'gregorian' },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('PUT /api/campaigns/:id/calendar is 404 for unknown campaign', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${ulid()}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { system: 'gregorian' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('PUT without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${ulid()}/calendar`,
          payload: { system: 'gregorian' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('PUT rejects an unknown system value (400)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { system: 'not_a_real_system' },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('PUT rejects currentDate that is too long (400)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'PUT',
          url: `/api/campaigns/${campaignId}/calendar`,
          headers: { authorization: `Bearer ${token}` },
          payload: { currentDate: 'x'.repeat(41) }, // max is 40
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    // ---- POST /api/campaigns/:id/calendar/entries --------------------------

    it('GM can create a calendar entry (201) and DB row is present', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-06-15', title: 'Dragon Attack', body: 'A big red dragon appeared.' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{
          id: string;
          calendarId: string;
          inWorldDate: string;
          title: string;
          body: string | null;
          createdBy: string;
        }>;
        expect(body.data.inWorldDate).toBe('0001-06-15');
        expect(body.data.title).toBe('Dragon Attack');
        expect(body.data.createdBy).toBe(gmId);

        const row = await prisma.timelineEntry.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.title).toBe('Dragon Attack');
        expect(row.body).toBe('A big red dragon appeared.');
      } finally {
        await app.close();
      }
    });

    it('POST entry with optional sessionId (201)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeCalendar(campaignId);
      // Create a session to reference
      const sessionId = ulid();
      await prisma.campaignSession.create({
        data: { id: sessionId, campaignId, serverId, title: 'Session 1' },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-07-01', title: 'Session Recap', sessionId },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string; sessionId: string | null }>;
        const row = await prisma.timelineEntry.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.sessionId).toBe(sessionId);
      } finally {
        await app.close();
      }
    });

    it('POST entry returns 400 when no calendar exists yet', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      // Deliberately do NOT create a calendar

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-01-01', title: 'Too Early' },
        });
        expect(res.statusCode).toBe(400);
        // No entry should exist
        const count = await prisma.timelineEntry.count();
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('POST entry is 403 for a campaign member (player)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, playerId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(playerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-01-01', title: 'Player Attempt' },
        });
        expect(res.statusCode).toBe(403);
        const count = await prisma.timelineEntry.count();
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('POST entry is 404 for an unknown campaign', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${ulid()}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-01-01', title: 'Orphan' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('POST entry is 400 when body fails validation (empty title)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-01-01', title: '' }, // min(1)
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST entry is 400 when inWorldDate is missing', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { title: 'No Date' },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST entry is 400 when body exceeds max length', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeCalendar(campaignId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/calendar/entries`,
          headers: { authorization: `Bearer ${token}` },
          payload: { inWorldDate: '0001-01-01', title: 'Too Long', body: 'x'.repeat(8001) },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST entry without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${ulid()}/calendar/entries`,
          payload: { inWorldDate: '0001-01-01', title: 'Nobody' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- DELETE /api/calendar-entries/:id ----------------------------------

    it('GM can delete a calendar entry (200) and the row is gone', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      const calId = await makeCalendar(campaignId);
      const entryId = await makeEntry(calId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/calendar-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.data.id).toBe(entryId);

        const row = await prisma.timelineEntry.findUnique({ where: { id: entryId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE is 403 for a campaign member (player)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, playerId);
      const calId = await makeCalendar(campaignId);
      const entryId = await makeEntry(calId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(playerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/calendar-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        // Entry must survive
        const row = await prisma.timelineEntry.findUnique({ where: { id: entryId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE is 403 for a non-member server member', async () => {
      const gmId = await makeUser('gm');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, outsiderId);
      const campaignId = await makeCampaign(serverId, gmId);
      const calId = await makeCalendar(campaignId);
      const entryId = await makeEntry(calId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/calendar-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('DELETE /api/calendar-entries/:id is 404 for an unknown entry', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/calendar-entries/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('DELETE without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/calendar-entries/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  },
);
