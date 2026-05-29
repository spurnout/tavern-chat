/**
 * Integration coverage for the server-scoped soundboard surface in
 * `apps/api/src/routes/soundboard.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Auth + permission model:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - GET  /api/servers/:id/soundboard          requires VIEW_CHANNEL  (in @everyone)
 *   - POST /api/servers/:id/soundboard          requires MANAGE_EMOJIS (NOT in @everyone)
 *     - additionally validates attachment kind (audio/voice_message) and status (ready)
 *   - PATCH  /api/soundboard/:id               requires MANAGE_EMOJIS
 *   - DELETE /api/soundboard/:id               requires MANAGE_EMOJIS
 *   - POST /api/voice/:channelId/soundboard     requires SPEAK_VOICE   (in @everyone)
 *   - POST /api/voice/:channelId/soundboard/stop requires SPEAK_VOICE  (in @everyone)
 *
 *   Server owners bypass all permission checks.
 *   SPEAK_VOICE is in PERMISSION_DEFAULT_EVERYONE, MANAGE_EMOJIS is not.
 *
 * Federation is off — no outbound queue touched.
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
 * A server owned by `ownerId` with an @everyone role + one text channel + one
 * voice channel. `extraEveryonePerms` is OR-ed onto the default @everyone bitset.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture & { voiceChannelId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  const voiceChannelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Sound Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'general' } });
  await prisma.channel.create({ data: { id: voiceChannelId, serverId, type: 'voice', name: 'tavern-hall' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId, voiceChannelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/**
 * Seed a ready audio attachment for the given uploader.
 * Used to satisfy the soundboard POST validation.
 */
async function makeAudioAttachment(
  uploaderId: string,
  kind: 'audio' | 'voice_message' | 'image' = 'audio',
  status: 'ready' | 'pending' | 'processing' = 'ready',
): Promise<string> {
  const id = ulid();
  await prisma.attachment.create({
    data: {
      id,
      uploaderId,
      kind,
      filename: 'clip.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 12345n,
      storageBucket: 'test',
      storageKey: `audio/${id}.mp3`,
      status,
    },
  });
  return id;
}

/** Seed a soundboard clip directly (for PATCH/DELETE/cue fixtures). */
async function makeClip(
  serverId: string,
  addedBy: string,
  attachmentId: string,
  name = 'Drum Roll',
  isAmbient = false,
  position = 0,
): Promise<string> {
  const id = ulid();
  await prisma.soundboardClip.create({
    data: {
      id,
      serverId,
      name,
      attachmentId,
      color: null,
      position,
      isAmbient,
      addedBy,
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

describe.skipIf(!dockerOk)('soundboard routes (apps/api/src/routes/soundboard.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.soundboardClip.deleteMany({});
    await prisma.attachment.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ── GET /api/servers/:id/soundboard ────────────────────────────────────────

  it('lists clips for a server member (200), ordered by position asc', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const id1 = await makeClip(serverId, ownerId, att, 'First', false, 0);
    const id2 = await makeClip(serverId, ownerId, att, 'Second', false, 1);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; name: string; position: number }>>;
      expect(body.ok).toBe(true);
      expect(body.data.length).toBe(2);
      expect(body.data[0]?.id).toBe(id1);
      expect(body.data[0]?.position).toBe(0);
      expect(body.data[1]?.id).toBe(id2);
      expect(body.data[1]?.position).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('returns empty array when no clips exist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:id/soundboard is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/soundboard`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:id/soundboard is 403 for a non-member (lacks VIEW_CHANNEL)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    // outsider is NOT a server member

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/servers/:id/soundboard ───────────────────────────────────────

  it('the server owner can add a clip (201) and position is auto-assigned', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const attId = await makeAudioAttachment(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Thunder', attachmentId: attId, color: '#ff0000' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        serverId: string;
        name: string;
        attachmentId: string;
        color: string | null;
        position: number;
        isAmbient: boolean;
        addedBy: string;
        createdAt: string;
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('Thunder');
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.attachmentId).toBe(attId);
      expect(body.data.color).toBe('#ff0000');
      expect(body.data.position).toBe(0); // first clip → position 0
      expect(body.data.isAmbient).toBe(false);
      expect(body.data.addedBy).toBe(ownerId);

      const row = await prisma.soundboardClip.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.name).toBe('Thunder');
    } finally {
      await app.close();
    }
  });

  it('positions auto-increment: second clip gets position 1', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    await makeClip(serverId, ownerId, att, 'First', false, 0);

    const att2 = await makeAudioAttachment(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Second Clip', attachmentId: att2 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ position: number }>;
      expect(body.data.position).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('isAmbient flag is persisted when set to true', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const attId = await makeAudioAttachment(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ambient Rain', attachmentId: attId, isAmbient: true },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ isAmbient: boolean }>;
      expect(body.data.isAmbient).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('accepts a voice_message attachment kind', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const attId = await makeAudioAttachment(ownerId, 'voice_message');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Voice Clip', attachmentId: attId },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_EMOJIS can add a clip (201)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_EMOJIS);
    await addMember(serverId, modId);
    const attId = await makeAudioAttachment(modId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Mod Clip', attachmentId: attId },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_EMOJIS) cannot add a clip (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const attId = await makeAudioAttachment(memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Sneaky Clip', attachmentId: attId },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.soundboardClip.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/soundboard is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${ulid()}/soundboard`,
        payload: { name: 'Ghost', attachmentId: ulid() },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when name is missing', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { attachmentId: ulid() }, // missing name
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when attachmentId is missing', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'NoAtt' }, // missing attachmentId
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 404 when attachment does not exist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Missing Att', attachmentId: ulid() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when attachment kind is image (not audio)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const attId = await makeAudioAttachment(ownerId, 'image');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Wrong Kind', attachmentId: attId },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when attachment status is not ready (pending)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const attId = await makeAudioAttachment(ownerId, 'audio', 'pending');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Not Ready', attachmentId: attId },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── PATCH /api/soundboard/:id ──────────────────────────────────────────────

  it('the owner can patch a clip name (200) and change persists', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Old Name');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/soundboard/${clipId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'New Name' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; name: string }>;
      expect(body.data.name).toBe('New Name');

      const row = await prisma.soundboardClip.findUniqueOrThrow({ where: { id: clipId } });
      expect(row.name).toBe('New Name');
    } finally {
      await app.close();
    }
  });

  it('PATCH can toggle isAmbient flag only', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Rain Loop', false);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/soundboard/${clipId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { isAmbient: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string; isAmbient: boolean }>;
      expect(body.data.isAmbient).toBe(true);
      expect(body.data.name).toBe('Rain Loop'); // unchanged
    } finally {
      await app.close();
    }
  });

  it('PATCH can set color to null (nullify)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att);
    // Seed a color first
    await prisma.soundboardClip.update({ where: { id: clipId }, data: { color: '#aabbcc' } });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/soundboard/${clipId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: null },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ color: string | null }>;
      expect(body.data.color).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/soundboard/:id is 404 for an unknown clip', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/soundboard/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/soundboard/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/soundboard/${ulid()}`,
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_EMOJIS) cannot patch a clip (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Protected');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/soundboard/${clipId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.soundboardClip.findUniqueOrThrow({ where: { id: clipId } });
      expect(row.name).toBe('Protected');
    } finally {
      await app.close();
    }
  });

  // ── DELETE /api/soundboard/:id ─────────────────────────────────────────────

  it('the owner can delete a clip (200) and the row is gone', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Doomed');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/soundboard/${clipId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(clipId);

      const row = await prisma.soundboardClip.findUnique({ where: { id: clipId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/soundboard/:id is 404 for an unknown clip', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/soundboard/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/soundboard/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/soundboard/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_EMOJIS) cannot delete a clip (403), row survives', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Survivor');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/soundboard/${clipId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.soundboardClip.findUnique({ where: { id: clipId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ── POST /api/voice/:channelId/soundboard (cue) ────────────────────────────

  it('a member with SPEAK_VOICE can cue a clip (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, voiceChannelId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Epic Fanfare');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId, loop: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('cue with loop:true is accepted (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, voiceChannelId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att, 'Looper');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId, loop: true },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('cue is 404 when the clip does not exist', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId: ulid() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('cue is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${ulid()}/soundboard`,
        payload: { clipId: ulid() },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('cue is 400 when clipId is missing from body', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // clipId required
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('cue is 403 when caller lacks SPEAK_VOICE on the voice channel', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
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
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/voice/:channelId/soundboard/stop ─────────────────────────────

  it('a member with SPEAK_VOICE can stop a clip (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, voiceChannelId } = await makeServer(ownerId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard/stop`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('stop is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${ulid()}/soundboard/stop`,
        payload: { clipId: ulid() },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('stop is 400 when clipId is missing', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard/stop`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // clipId required
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('stop is 403 when caller lacks SPEAK_VOICE', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, everyoneId, voiceChannelId } = await makeServer(ownerId);
    // Strip SPEAK_VOICE from @everyone
    await prisma.role.update({
      where: { id: everyoneId },
      data: {
        permissions: new Prisma.Decimal(
          serializePermissions(PERMISSION_DEFAULT_EVERYONE & ~Permission.SPEAK_VOICE),
        ),
      },
    });
    await addMember(serverId, memberId);
    const att = await makeAudioAttachment(ownerId);
    const clipId = await makeClip(serverId, ownerId, att);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/soundboard/stop`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('stop on unknown channel returns 404 (requireChannelPermission cannot find it)', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${ulid()}/soundboard/stop`,
        headers: { authorization: `Bearer ${token}` },
        payload: { clipId: ulid() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
