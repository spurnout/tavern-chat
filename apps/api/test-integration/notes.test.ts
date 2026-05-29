/**
 * Integration coverage for the campaign-note surface in
 * `apps/api/src/routes/notes.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Routes under test:
 *   GET  /api/campaigns/:id/notes        (list, with GM-only visibility gate)
 *   POST /api/notes                      (create)
 *   PATCH /api/notes/:id                 (update)
 *   DELETE /api/notes/:id                (delete)
 *
 * Auth + permission model:
 *   - Every handler calls `app.requireUser` → 401 when no token.
 *   - GET list: caller must have `getServerPermissions !== 0n`; otherwise
 *     the campaign is hidden with 404. Visibility is further filtered:
 *       · GM, ADMINISTRATOR, or VIEW_GM_NOTES → sees all notes.
 *       · plain server member → sees only `public_to_party` notes.
 *   - POST /api/notes: the GM may always create; anyone else needs
 *     MANAGE_CAMPAIGN_NOTES; missing → 403. Bad body → 400.
 *   - PATCH /api/notes/:id: the note's author OR the GM may edit; anyone else
 *     needs MANAGE_CAMPAIGN_NOTES. Unknown note → 404, bad body → 400.
 *   - DELETE /api/notes/:id: same gate as PATCH. Unknown note → 404.
 *
 * Ordering: GET list is pinned desc, then updatedAt desc.
 *
 * Fixtures: a server (owner == GM) with an @everyone role + one text channel.
 * `extraEveryonePerms` grants MANAGE_CAMPAIGN_NOTES / VIEW_GM_NOTES to all
 * members to exercise the privileged paths. Federation is off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, Permission, serializePermissions, ulid } from '@tavern/shared';
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
}

/**
 * A server owned by `ownerId` with an @everyone role + one text channel and
 * the owner as a member. `extraEveryonePerms` is OR-ed onto the default
 * @everyone bitset to grant additional permissions to all members.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Notes Tavern' } });
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
  return { serverId, everyoneId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

async function makeCampaign(serverId: string, gmUserId: string): Promise<string> {
  const id = ulid();
  await prisma.campaign.create({ data: { id, serverId, name: 'The Lost Mine', gmUserId } });
  return id;
}

/** Seed a campaign note directly (used to prime GET/PATCH/DELETE fixtures). */
async function makeNote(
  campaignId: string,
  serverId: string,
  authorId: string,
  opts: {
    title?: string;
    body?: string;
    visibility?: 'public_to_party' | 'gm_only';
    pinned?: boolean;
  } = {},
): Promise<string> {
  const id = ulid();
  await prisma.campaignNote.create({
    data: {
      id,
      campaignId,
      serverId,
      authorId,
      title: opts.title ?? 'Untitled',
      body: opts.body ?? '',
      visibility: opts.visibility ?? 'public_to_party',
      pinned: opts.pinned ?? false,
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

type NoteDto = {
  id: string;
  campaignId: string;
  serverId: string;
  authorId: string;
  title: string;
  body: string;
  visibility: 'public_to_party' | 'gm_only';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('campaign note routes (apps/api/src/routes/notes.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // ---- GET /api/campaigns/:id/notes --------------------------------------

  it('the GM sees all notes including gm_only (200), ordered pinned desc then updatedAt desc', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const publicNoteId = await makeNote(campaignId, serverId, gmId, {
      title: 'Public Note',
      visibility: 'public_to_party',
    });
    const gmNoteId = await makeNote(campaignId, serverId, gmId, {
      title: 'GM Only',
      visibility: 'gm_only',
    });
    const pinnedNoteId = await makeNote(campaignId, serverId, gmId, {
      title: 'Pinned',
      visibility: 'public_to_party',
      pinned: true,
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/notes`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<NoteDto[]>;
      expect(body.ok).toBe(true);
      // All three notes are returned.
      expect(body.data).toHaveLength(3);
      // Pinned note comes first.
      expect(body.data[0]!.id).toBe(pinnedNoteId);
      expect(body.data[0]!.pinned).toBe(true);
      // GM-only note is present somewhere in the list.
      const ids = body.data.map((n) => n.id);
      expect(ids).toContain(gmNoteId);
      expect(ids).toContain(publicNoteId);
    } finally {
      await app.close();
    }
  });

  it('a plain server member (no VIEW_GM_NOTES) only sees public_to_party notes (200)', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeNote(campaignId, serverId, gmId, { title: 'Public', visibility: 'public_to_party' });
    await makeNote(campaignId, serverId, gmId, { title: 'GM Secret', visibility: 'gm_only' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/notes`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<NoteDto[]>;
      // Only the public note is visible to the plain member.
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.title).toBe('Public');
      expect(body.data[0]!.visibility).toBe('public_to_party');
    } finally {
      await app.close();
    }
  });

  it('a member with VIEW_GM_NOTES sees gm_only notes too (200)', async () => {
    const gmId = await makeUser('gm');
    const privilegedMemberId = await makeUser('privileged');
    const { serverId } = await makeServer(gmId, Permission.VIEW_GM_NOTES);
    await addMember(serverId, privilegedMemberId);
    const campaignId = await makeCampaign(serverId, gmId);
    await makeNote(campaignId, serverId, gmId, { title: 'GM Secret', visibility: 'gm_only' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(privilegedMemberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/notes`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<NoteDto[]>;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.visibility).toBe('gm_only');
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/notes is 404 for an unknown campaign', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/notes`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/notes is 404 for a non-member (existence not leaked)', async () => {
    const gmId = await makeUser('gm');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(gmId);
    // outsider is NOT added as a server member.
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/notes`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/campaigns/:id/notes without token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${ulid()}/notes`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/notes ---------------------------------------------------

  it('the GM can create a note (201) — all fields persisted correctly', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId,
          title: 'Session Zero Prep',
          body: 'Gather character backstories.',
          visibility: 'gm_only',
          pinned: true,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<NoteDto>;
      expect(body.ok).toBe(true);
      expect(body.data.campaignId).toBe(campaignId);
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.authorId).toBe(gmId);
      expect(body.data.title).toBe('Session Zero Prep');
      expect(body.data.body).toBe('Gather character backstories.');
      expect(body.data.visibility).toBe('gm_only');
      expect(body.data.pinned).toBe(true);

      const row = await prisma.campaignNote.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.authorId).toBe(gmId);
      expect(row.pinned).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_CAMPAIGN_NOTES can create a note (201)', async () => {
    const gmId = await makeUser('gm');
    const privilegedMemberId = await makeUser('privileged');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGN_NOTES);
    await addMember(serverId, privilegedMemberId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(privilegedMemberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId,
          title: 'Player Recap',
          body: 'Last session summary.',
          visibility: 'public_to_party',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<NoteDto>;
      expect(body.data.authorId).toBe(privilegedMemberId);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_CAMPAIGN_NOTES) is rejected with 403, no row written', async () => {
    const gmId = await makeUser('gm');
    const plainMemberId = await makeUser('plain');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, plainMemberId);
    const campaignId = await makeCampaign(serverId, gmId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(plainMemberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId,
          title: 'Sneaky Note',
          body: 'Should be rejected.',
          visibility: 'public_to_party',
        },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.campaignNote.count({ where: { campaignId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/notes is 404 when the campaign does not exist', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId: ulid(),
          title: 'Orphan',
          body: 'No campaign.',
          visibility: 'public_to_party',
        },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/notes is 400 when the body fails validation (empty title)', async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId);
    const campaignId = await makeCampaign(serverId, gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { authorization: `Bearer ${token}` },
        payload: { campaignId, title: '', body: 'empty title is invalid', visibility: 'public_to_party' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/notes without token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notes',
        payload: { campaignId: ulid(), title: 'Test', body: '', visibility: 'public_to_party' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/notes/:id ----------------------------------------------

  it("the note's author can update their own note (200) and changes persist", async () => {
    const gmId = await makeUser('gm');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGN_NOTES);
    const memberId = await makeUser('member');
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, memberId, {
      title: 'Before',
      body: 'Old body',
      visibility: 'public_to_party',
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'After', body: 'New body', pinned: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<NoteDto>;
      expect(body.data.title).toBe('After');
      expect(body.data.body).toBe('New body');
      expect(body.data.pinned).toBe(true);

      const row = await prisma.campaignNote.findUniqueOrThrow({ where: { id: noteId } });
      expect(row.title).toBe('After');
      expect(row.pinned).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('the GM can update a note written by a different author (200)', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);
    // Seed the note as authored by the member.
    const noteId = await makeNote(campaignId, serverId, memberId, {
      title: 'Member Note',
      visibility: 'public_to_party',
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'GM Edited' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.campaignNote.findUniqueOrThrow({ where: { id: noteId } });
      expect(row.title).toBe('GM Edited');
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_CAMPAIGN_NOTES can update another member\'s note (200)', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const editorId = await makeUser('editor');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGN_NOTES);
    await addMember(serverId, authorId);
    await addMember(serverId, editorId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, authorId, { title: 'Original' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(editorId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Edited by privileged member' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.campaignNote.findUniqueOrThrow({ where: { id: noteId } });
      expect(row.title).toBe('Edited by privileged member');
    } finally {
      await app.close();
    }
  });

  it('a plain member (neither author nor GM nor MANAGE_CAMPAIGN_NOTES) is rejected with 403, note unchanged', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, authorId);
    await addMember(serverId, otherId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, authorId, { title: 'Locked' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.campaignNote.findUniqueOrThrow({ where: { id: noteId } });
      expect(row.title).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/notes/:id is 404 for an unknown note id', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/notes/:id without token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${ulid()}`,
        payload: { title: 'NoAuth' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/notes/:id ---------------------------------------------

  it('the GM can delete any note (200) and the row is gone', async () => {
    const gmId = await makeUser('gm');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, memberId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, memberId, { title: 'Doomed' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(noteId);

      const row = await prisma.campaignNote.findUnique({ where: { id: noteId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("the note's author can delete their own note (200)", async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, authorId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, authorId, { title: 'Mine to delete' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(authorId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.campaignNote.findUnique({ where: { id: noteId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_CAMPAIGN_NOTES can delete any note (200)', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const editorId = await makeUser('editor');
    const { serverId } = await makeServer(gmId, Permission.MANAGE_CAMPAIGN_NOTES);
    await addMember(serverId, authorId);
    await addMember(serverId, editorId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, authorId, { title: 'Will be deleted' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(editorId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.campaignNote.findUnique({ where: { id: noteId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a plain member (neither author nor GM) is rejected with 403 and the row survives', async () => {
    const gmId = await makeUser('gm');
    const authorId = await makeUser('author');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(gmId);
    await addMember(serverId, authorId);
    await addMember(serverId, otherId);
    const campaignId = await makeCampaign(serverId, gmId);
    const noteId = await makeNote(campaignId, serverId, authorId, { title: 'Survivor' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/notes/${noteId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.campaignNote.findUnique({ where: { id: noteId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/notes/:id is 404 for an unknown note id', async () => {
    const gmId = await makeUser('gm');
    await makeServer(gmId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(gmId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/notes/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/notes/:id without token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/notes/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
