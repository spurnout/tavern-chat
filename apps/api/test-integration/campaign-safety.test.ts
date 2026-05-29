/**
 * Integration coverage for the campaign-scoped safety-tools surface in
 * `apps/api/src/routes/campaign-safety.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode (via `getServerPermissions`):
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - GET  /api/campaigns/:id/safety
 *       perms === 0n (not a server member) → 404 "Campaign not found"
 *       GM / VIEW_GM_NOTES / ADMINISTRATOR → sees all entries (including private)
 *       other members → sees non-private entries + their own private entries
 *   - POST /api/campaigns/:id/safety
 *       any server member (perms !== 0n) may create; perms === 0n → 404
 *   - DELETE /api/safety-entries/:id
 *       author or GM may delete; others need ADMINISTRATOR; else → 403
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
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Safety Tavern' } });
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
  await prisma.campaign.create({ data: { id, serverId, name: 'Safety Session', gmUserId } });
  return id;
}

async function addCampaignMember(
  campaignId: string,
  userId: string,
  role: 'player' | 'co_gm' = 'player',
): Promise<void> {
  await prisma.campaignMember.create({ data: { campaignId, userId, role } });
}

/** Create a CampaignSafetyEntry directly for DELETE/GET fixture seeds. */
async function makeEntry(
  campaignId: string,
  authorId: string,
  opts: { kind?: string; content?: string; isPrivate?: boolean } = {},
): Promise<string> {
  const id = ulid();
  await prisma.campaignSafetyEntry.create({
    data: {
      id,
      campaignId,
      authorId,
      kind: opts.kind ?? 'line',
      content: opts.content ?? 'Test content',
      isPrivate: opts.isPrivate ?? false,
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

// Shape of a safety entry on the wire
interface SafetyEntryDto {
  id: string;
  campaignId: string;
  authorId: string;
  kind: string;
  content: string;
  isPrivate: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)(
  'campaign-safety routes (apps/api/src/routes/campaign-safety.ts)',
  () => {
    beforeEach(async () => {
      if (!dockerOk) return;
      await resetDb(prisma);
    });

    // ---- GET /api/campaigns/:id/safety -------------------------------------

    it('GET returns empty array when no entries exist (200)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<SafetyEntryDto[]>;
        expect(body.ok).toBe(true);
        expect(body.data).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('GET GM sees all entries including private ones (200)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, playerId);

      // Public entry from player, private entry from player
      await makeEntry(campaignId, playerId, { kind: 'line', content: 'Public line', isPrivate: false });
      await makeEntry(campaignId, playerId, { kind: 'veil', content: 'Private veil', isPrivate: true });

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<SafetyEntryDto[]>;
        expect(body.data).toHaveLength(2);
        expect(body.data.some((e) => e.content === 'Private veil')).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('GET player sees non-private entries and their own private entries, but not others private entries', async () => {
      const gmId = await makeUser('gm');
      const player1Id = await makeUser('player1');
      const player2Id = await makeUser('player2');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, player1Id);
      await addMember(serverId, player2Id);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, player1Id);
      await addCampaignMember(campaignId, player2Id);

      // Shared public entry
      await makeEntry(campaignId, gmId, { kind: 'star', content: 'Everyone loved the dragon', isPrivate: false });
      // player1's own private entry
      await makeEntry(campaignId, player1Id, { kind: 'line', content: 'Player1 private', isPrivate: true });
      // player2's private entry — player1 should NOT see this
      await makeEntry(campaignId, player2Id, { kind: 'veil', content: 'Player2 private', isPrivate: true });

      const app = await buildTestApp();
      try {
        const token = await mintToken(player1Id);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<SafetyEntryDto[]>;
        // player1 should see: public entry + own private entry
        expect(body.data).toHaveLength(2);
        const contents = body.data.map((e) => e.content);
        expect(contents).toContain('Everyone loved the dragon');
        expect(contents).toContain('Player1 private');
        expect(contents).not.toContain('Player2 private');
      } finally {
        await app.close();
      }
    });

    it('GET holder of VIEW_GM_NOTES sees all entries (200)', async () => {
      const gmId = await makeUser('gm');
      const privilegedId = await makeUser('privileged');
      const { serverId } = await makeServer(gmId, Permission.VIEW_GM_NOTES);
      await addMember(serverId, privilegedId);
      const campaignId = await makeCampaign(serverId, gmId);

      await makeEntry(campaignId, gmId, { kind: 'line', content: 'Secret', isPrivate: true });

      const app = await buildTestApp();
      try {
        const token = await mintToken(privilegedId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<SafetyEntryDto[]>;
        expect(body.data).toHaveLength(1);
        expect(body.data[0]!.content).toBe('Secret');
      } finally {
        await app.close();
      }
    });

    it('GET returns entries ordered by createdAt descending', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const id1 = ulid();
      const id2 = ulid();
      await prisma.campaignSafetyEntry.create({
        data: { id: id1, campaignId, authorId: gmId, kind: 'star', content: 'First', isPrivate: false },
      });
      // Small delay to ensure distinct createdAt
      await new Promise((r) => setTimeout(r, 5));
      await prisma.campaignSafetyEntry.create({
        data: { id: id2, campaignId, authorId: gmId, kind: 'wish', content: 'Second', isPrivate: false },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<SafetyEntryDto[]>;
        // Newest first
        expect(body.data[0]!.content).toBe('Second');
        expect(body.data[1]!.content).toBe('First');
      } finally {
        await app.close();
      }
    });

    it('GET response shape has expected fields', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);
      await makeEntry(campaignId, gmId, { kind: 'note', content: 'Shape check', isPrivate: false });

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<SafetyEntryDto[]>;
        const entry = body.data[0]!;
        expect(typeof entry.id).toBe('string');
        expect(entry.campaignId).toBe(campaignId);
        expect(entry.authorId).toBe(gmId);
        expect(entry.kind).toBe('note');
        expect(entry.content).toBe('Shape check');
        expect(entry.isPrivate).toBe(false);
        expect(typeof entry.createdAt).toBe('string');
        // ISO format sanity
        expect(() => new Date(entry.createdAt)).not.toThrow();
      } finally {
        await app.close();
      }
    });

    it('GET is 404 for a non-server member (perms === 0n)', async () => {
      const gmId = await makeUser('gm');
      const strangerId = await makeUser('stranger');
      const { serverId } = await makeServer(gmId);
      // strangerId never joined the server
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(strangerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        // route returns 404 to avoid leaking campaign existence
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('GET is 404 for an unknown campaign', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${ulid()}/safety`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('GET without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/campaigns/${ulid()}/safety`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- POST /api/campaigns/:id/safety ------------------------------------

    it('a server member (player) can create a public safety entry (201)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(playerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'star', content: 'The heist scene was great!' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<SafetyEntryDto>;
        expect(body.data.kind).toBe('star');
        expect(body.data.content).toBe('The heist scene was great!');
        expect(body.data.authorId).toBe(playerId);
        expect(body.data.isPrivate).toBe(false);
        expect(body.data.campaignId).toBe(campaignId);

        const row = await prisma.campaignSafetyEntry.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.authorId).toBe(playerId);
      } finally {
        await app.close();
      }
    });

    it('a server member can create a private safety entry (201, isPrivate=true)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(playerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'line', content: 'No graphic violence', isPrivate: true },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<SafetyEntryDto>;
        expect(body.data.isPrivate).toBe(true);

        const row = await prisma.campaignSafetyEntry.findUniqueOrThrow({ where: { id: body.data.id } });
        expect(row.isPrivate).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('POST response shape has all expected fields', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'wish', content: 'More puzzles please' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<SafetyEntryDto>;
        expect(typeof body.data.id).toBe('string');
        expect(body.data.campaignId).toBe(campaignId);
        expect(body.data.authorId).toBe(gmId);
        expect(body.data.kind).toBe('wish');
        expect(body.data.content).toBe('More puzzles please');
        expect(body.data.isPrivate).toBe(false);
        expect(typeof body.data.createdAt).toBe('string');
      } finally {
        await app.close();
      }
    });

    it('GM can create a safety entry (201)', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'note', content: 'Session 0 note' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<SafetyEntryDto>;
        expect(body.data.authorId).toBe(gmId);
      } finally {
        await app.close();
      }
    });

    it('POST is 404 for a non-server member (perms === 0n)', async () => {
      const gmId = await makeUser('gm');
      const strangerId = await makeUser('stranger');
      const { serverId } = await makeServer(gmId);
      // strangerId is not a member of this server
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(strangerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'star', content: 'Sneaking in' },
        });
        expect(res.statusCode).toBe(404);
        const count = await prisma.campaignSafetyEntry.count({ where: { campaignId } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('POST is 404 for an unknown campaign', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${ulid()}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'star', content: 'Orphan' },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('POST is 400 when kind is invalid', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'not_a_kind', content: 'Invalid kind test' },
        });
        expect(res.statusCode).toBe(400);
        const count = await prisma.campaignSafetyEntry.count({ where: { campaignId } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('POST is 400 when content is empty', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'star', content: '' }, // min(1)
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST is 400 when content exceeds max length', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: 'note', content: 'x'.repeat(2001) }, // max is 2000
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST is 400 when kind is missing', async () => {
      const gmId = await makeUser('gm');
      const { serverId } = await makeServer(gmId);
      const campaignId = await makeCampaign(serverId, gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${campaignId}/safety`,
          headers: { authorization: `Bearer ${token}` },
          payload: { content: 'No kind provided' },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/campaigns/${ulid()}/safety`,
          payload: { kind: 'star', content: 'Anon attempt' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // Test each valid kind value
    it.each(['line', 'veil', 'star', 'wish', 'note'] as const)(
      'POST accepts kind="%s" (201)',
      async (kind) => {
        const gmId = await makeUser('gm');
        const { serverId } = await makeServer(gmId);
        const campaignId = await makeCampaign(serverId, gmId);

        const app = await buildTestApp();
        try {
          const token = await mintToken(gmId);
          const res = await app.inject({
            method: 'POST',
            url: `/api/campaigns/${campaignId}/safety`,
            headers: { authorization: `Bearer ${token}` },
            payload: { kind, content: `Testing kind ${kind}` },
          });
          expect(res.statusCode).toBe(201);
          const body = res.json() as OkBody<SafetyEntryDto>;
          expect(body.data.kind).toBe(kind);
        } finally {
          await app.close();
        }
      },
    );

    // ---- DELETE /api/safety-entries/:id ------------------------------------

    it('the author can delete their own entry (200) and the row is gone', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, playerId);
      const entryId = await makeEntry(campaignId, playerId, { kind: 'star', content: 'My entry' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(playerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/safety-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.data.id).toBe(entryId);

        const row = await prisma.campaignSafetyEntry.findUnique({ where: { id: entryId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('the GM can delete any entry, including one they did not author (200)', async () => {
      const gmId = await makeUser('gm');
      const playerId = await makeUser('player');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, playerId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, playerId);
      const entryId = await makeEntry(campaignId, playerId, { kind: 'line', content: 'Players entry' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/safety-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const row = await prisma.campaignSafetyEntry.findUnique({ where: { id: entryId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a third player (not the author, not the GM) cannot delete (403), row survives', async () => {
      const gmId = await makeUser('gm');
      const authorId = await makeUser('author');
      const otherId = await makeUser('other');
      const { serverId } = await makeServer(gmId);
      await addMember(serverId, authorId);
      await addMember(serverId, otherId);
      const campaignId = await makeCampaign(serverId, gmId);
      await addCampaignMember(campaignId, authorId);
      await addCampaignMember(campaignId, otherId);
      const entryId = await makeEntry(campaignId, authorId, { kind: 'veil', content: 'Author entry' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(otherId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/safety-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        const row = await prisma.campaignSafetyEntry.findUnique({ where: { id: entryId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a server member with ADMINISTRATOR permission can delete any entry (200)', async () => {
      const gmId = await makeUser('gm');
      const adminId = await makeUser('admin');
      const { serverId } = await makeServer(gmId, Permission.ADMINISTRATOR);
      await addMember(serverId, adminId);
      const campaignId = await makeCampaign(serverId, gmId);
      const entryId = await makeEntry(campaignId, gmId, { kind: 'line', content: 'GM entry' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(adminId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/safety-entries/${entryId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const row = await prisma.campaignSafetyEntry.findUnique({ where: { id: entryId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE /api/safety-entries/:id is 404 for an unknown entry', async () => {
      const gmId = await makeUser('gm');
      await makeServer(gmId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(gmId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/safety-entries/${ulid()}`,
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
          url: `/api/safety-entries/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  },
);
