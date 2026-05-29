/**
 * Integration coverage for the watch-party surface in
 * `apps/api/src/routes/watch-party.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Permission model encoded by the route:
 *   - requireUser → 401 when no token
 *   - GET   /api/voice/:channelId/watch-party   VIEW_CHANNEL (default in @everyone)
 *   - POST  /api/voice/:channelId/watch-party   SPEAK_VOICE  (default in @everyone)
 *   - PATCH /api/watch-party/:id                host-only (no permission bit check,
 *                                                non-host → 403)
 *   - POST  /api/watch-party/:id/takeover       MANAGE_CHANNELS (NOT default)
 *   - DELETE /api/watch-party/:id               host OR MANAGE_CHANNELS
 *
 * SPEAK_VOICE and VIEW_CHANNEL are both in PERMISSION_DEFAULT_EVERYONE so
 * server members can call those without extra grants.  MANAGE_CHANNELS is not
 * in the default — tests that need it pass a bit into `makeServer`.
 *
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

// ---------------------------------------------------------------------------
// Fixtures
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
  voiceChannelId: string;
}

/**
 * A server owned by `ownerId` with an @everyone role + one voice channel.
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const voiceChannelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Watch Tavern' } });
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
  await prisma.channel.create({
    data: { id: voiceChannelId, serverId, type: 'voice', name: 'movie-night' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, voiceChannelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/**
 * Seed a WatchParty row directly (for PATCH/DELETE/takeover fixtures).
 */
async function makeWatchParty(
  channelId: string,
  hostUserId: string,
  videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  source = 'youtube',
): Promise<string> {
  const id = ulid();
  await prisma.watchParty.create({
    data: {
      id,
      channelId,
      hostUserId,
      videoUrl,
      source,
      currentSec: 0,
      isPlaying: false,
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('watch-party routes (apps/api/src/routes/watch-party.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // Delete children first, then parents.
    await prisma.apiToken.deleteMany({});
    await prisma.watchParty.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // =========================================================================
  // GET /api/voice/:channelId/watch-party
  // =========================================================================

  it('GET returns null data when no party is running (200)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${voiceChannelId}/watch-party`,
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

  it('GET returns the running party serialised (200)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        id: string;
        channelId: string;
        hostUserId: string;
        videoUrl: string;
        source: string;
        startedAt: string;
        currentSec: number;
        isPlaying: boolean;
        lastUpdatedAt: string;
      }>;
      expect(body.data.id).toBe(partyId);
      expect(body.data.channelId).toBe(voiceChannelId);
      expect(body.data.hostUserId).toBe(ownerId);
      expect(body.data.source).toBe('youtube');
      expect(body.data.isPlaying).toBe(false);
      expect(typeof body.data.startedAt).toBe('string');
      expect(typeof body.data.lastUpdatedAt).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('GET is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${voiceChannelId}/watch-party`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET is 404 when channelId does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${ulid()}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
      });
      // VIEW_CHANNEL on unknown channel → 404 (channel not found by requireChannelPermission)
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // POST /api/voice/:channelId/watch-party
  // =========================================================================

  it('POST starts a new watch party (201) and persists the row', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { videoUrl: 'https://www.youtube.com/watch?v=abc123456789', source: 'youtube' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        channelId: string;
        hostUserId: string;
        videoUrl: string;
        source: string;
        currentSec: number;
        isPlaying: boolean;
      }>;
      expect(body.data.channelId).toBe(voiceChannelId);
      expect(body.data.hostUserId).toBe(ownerId);
      expect(body.data.videoUrl).toBe('https://www.youtube.com/watch?v=abc123456789');
      expect(body.data.source).toBe('youtube');
      expect(body.data.currentSec).toBe(0);
      expect(body.data.isPlaying).toBe(false);

      const row = await prisma.watchParty.findUnique({ where: { id: body.data.id } });
      expect(row).not.toBeNull();
      expect(row?.hostUserId).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('POST is 409 when a party already exists in the channel', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { videoUrl: 'https://example.com/video.mp4', source: 'mp4' },
      });
      expect(res.statusCode).toBe(409);
      // Only one row should exist
      const count = await prisma.watchParty.count({ where: { channelId: voiceChannelId } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('POST is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        payload: { videoUrl: 'https://example.com/video.mp4', source: 'mp4' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST is 403 when the member lacks SPEAK_VOICE', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('muted');
    // Strip SPEAK_VOICE from @everyone
    const { serverId, everyoneId, voiceChannelId } = await makeServer(ownerId);
    await prisma.role.update({
      where: { id: everyoneId },
      data: {
        permissions: new Prisma.Decimal(
          serializePermissions(PERMISSION_DEFAULT_EVERYONE & ~Permission.SPEAK_VOICE),
        ),
      },
    });
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { videoUrl: 'https://example.com/video.mp4', source: 'mp4' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.watchParty.count({ where: { channelId: voiceChannelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when videoUrl is missing', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { source: 'youtube' }, // missing videoUrl
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when source is not a valid enum value', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { videoUrl: 'https://example.com/video.mp4', source: 'not-a-real-source' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when videoUrl is not a valid URL', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { videoUrl: 'not-a-url', source: 'youtube' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 404 when the channel does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${ulid()}/watch-party`,
        headers: { authorization: `Bearer ${token}` },
        payload: { videoUrl: 'https://example.com/v.mp4', source: 'mp4' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // PATCH /api/watch-party/:id
  // =========================================================================

  it('PATCH by the host updates playback state (200) and persists changes', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { currentSec: 42.5, isPlaying: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ currentSec: number; isPlaying: boolean; id: string }>;
      expect(body.data.currentSec).toBe(42.5);
      expect(body.data.isPlaying).toBe(true);
      expect(body.data.id).toBe(partyId);

      const row = await prisma.watchParty.findUniqueOrThrow({ where: { id: partyId } });
      expect(row.currentSec).toBe(42.5);
      expect(row.isPlaying).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 403 when caller is not the host', async () => {
    const ownerId = await makeUser('owner');
    const viewerId = await makeUser('viewer');
    const { serverId, voiceChannelId } = await makeServer(ownerId);
    await addMember(serverId, viewerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { currentSec: 999, isPlaying: true },
      });
      expect(res.statusCode).toBe(403);
      // DB state must be unchanged
      const row = await prisma.watchParty.findUniqueOrThrow({ where: { id: partyId } });
      expect(row.currentSec).toBe(0);
      expect(row.isPlaying).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watch-party/${partyId}`,
        payload: { currentSec: 10, isPlaying: false },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 404 for an unknown watch party id', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watch-party/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { currentSec: 0, isPlaying: false },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 400 when currentSec is negative', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { currentSec: -1, isPlaying: false },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 400 when isPlaying is missing', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { currentSec: 10 }, // missing isPlaying
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // POST /api/watch-party/:id/takeover
  // =========================================================================

  it('takeover reassigns hostUserId to the caller (200) when caller has MANAGE_CHANNELS', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    // Grant MANAGE_CHANNELS to @everyone so modId has it
    const { serverId, voiceChannelId } = await makeServer(ownerId, Permission.MANAGE_CHANNELS);
    await addMember(serverId, modId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/watch-party/${partyId}/takeover`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ hostUserId: string; id: string }>;
      expect(body.data.hostUserId).toBe(modId);
      expect(body.data.id).toBe(partyId);

      const row = await prisma.watchParty.findUniqueOrThrow({ where: { id: partyId } });
      expect(row.hostUserId).toBe(modId);
    } finally {
      await app.close();
    }
  });

  it('takeover is 403 for a regular member lacking MANAGE_CHANNELS', async () => {
    const ownerId = await makeUser('owner');
    const viewerId = await makeUser('viewer');
    const { serverId, voiceChannelId } = await makeServer(ownerId); // no MANAGE_CHANNELS
    await addMember(serverId, viewerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/watch-party/${partyId}/takeover`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      // hostUserId must remain the original owner
      const row = await prisma.watchParty.findUniqueOrThrow({ where: { id: partyId } });
      expect(row.hostUserId).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('takeover is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId, Permission.MANAGE_CHANNELS);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/watch-party/${partyId}/takeover`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('takeover is 404 for an unknown watch party id', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId, Permission.MANAGE_CHANNELS);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/watch-party/${ulid()}/takeover`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // DELETE /api/watch-party/:id
  // =========================================================================

  it('DELETE by the host removes the row (200) and returns the id', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(partyId);

      const row = await prisma.watchParty.findUnique({ where: { id: partyId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE by a channel manager (MANAGE_CHANNELS) also succeeds (200)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const { serverId, voiceChannelId } = await makeServer(ownerId, Permission.MANAGE_CHANNELS);
    await addMember(serverId, modId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);

      const row = await prisma.watchParty.findUnique({ where: { id: partyId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE is 403 for a non-host member without MANAGE_CHANNELS', async () => {
    const ownerId = await makeUser('owner');
    const viewerId = await makeUser('viewer');
    const { serverId, voiceChannelId } = await makeServer(ownerId); // no MANAGE_CHANNELS in @everyone
    await addMember(serverId, viewerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/watch-party/${partyId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);

      const row = await prisma.watchParty.findUnique({ where: { id: partyId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const partyId = await makeWatchParty(voiceChannelId, ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/watch-party/${partyId}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('DELETE is 404 for an unknown watch party id', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/watch-party/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
