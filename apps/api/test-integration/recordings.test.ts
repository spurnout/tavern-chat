/**
 * Integration coverage for the recording surface in
 * `apps/api/src/routes/recordings.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Permission model encoded by the routes:
 *   - requireUser → 401 when no token
 *   - POST  .../propose    SPEAK_VOICE  (in default @everyone)
 *   - POST  .../consent    VIEW_CHANNEL (in default @everyone)
 *   - POST  .../start      SPEAK_VOICE  (in default @everyone)
 *   - POST  .../complete   SPEAK_VOICE  (in default @everyone)
 *   - GET   .../recordings VIEW_CHANNEL (in default @everyone)
 *   - DELETE /api/recordings/:id  recordedBy owner OR MANAGE_CHANNELS
 *
 * propose/consent/start broadcast gateway events only (no DB write) so the
 * tests assert on status codes and, where applicable, body shape. complete
 * and list both read/write SessionRecording rows — those also verify DB state.
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
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Rec Tavern' } });
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
    data: { id: voiceChannelId, serverId, type: 'voice', name: 'session-room' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, voiceChannelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/**
 * Seed an Attachment row owned by `uploaderId`.
 * `kind` must be one that the /complete handler accepts: audio, voice_message, or video.
 */
async function makeAttachment(
  uploaderId: string,
  kind: 'audio' | 'voice_message' | 'video' | 'image' = 'audio',
): Promise<string> {
  const id = ulid();
  await prisma.attachment.create({
    data: {
      id,
      uploaderId,
      kind,
      filename: 'session.webm',
      mimeType: kind === 'video' ? 'video/webm' : 'audio/webm',
      sizeBytes: 99999n,
      storageBucket: 'test',
      storageKey: `recordings/${id}.webm`,
      status: 'ready',
    },
  });
  return id;
}

/**
 * Seed a SessionRecording row directly (for DELETE/GET fixtures).
 */
async function makeSessionRecording(
  channelId: string,
  recordedBy: string,
  attachmentId: string,
): Promise<string> {
  const id = ulid();
  const now = new Date();
  const later = new Date(now.getTime() + 3600_000);
  await prisma.sessionRecording.create({
    data: {
      id,
      channelId,
      attachmentId,
      recordedBy,
      startedAt: now,
      endedAt: later,
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

describe.skipIf(!dockerOk)('recording routes (apps/api/src/routes/recordings.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // Delete children before parents.
    await prisma.apiToken.deleteMany({});
    await prisma.sessionRecording.deleteMany({});
    await prisma.attachment.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // =========================================================================
  // POST /api/voice/:channelId/recording/propose
  // =========================================================================

  it('propose broadcasts intent and returns ok (200) for a member with SPEAK_VOICE', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/propose`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.ok).toBe(true);
      expect(body.data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('propose is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/propose`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('propose is 403 when caller lacks SPEAK_VOICE', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('muted');
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
        url: `/api/voice/${voiceChannelId}/recording/propose`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('propose is 404 when the channel does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${ulid()}/recording/propose`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // POST /api/voice/:channelId/recording/consent
  // =========================================================================

  it('consent with true returns ok (200) for a member with VIEW_CHANNEL', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/consent`,
        headers: { authorization: `Bearer ${token}` },
        payload: { consent: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('consent with false also returns ok (200)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/consent`,
        headers: { authorization: `Bearer ${token}` },
        payload: { consent: false },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('consent is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/consent`,
        payload: { consent: true },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('consent is 400 when body is missing consent field', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/consent`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // missing consent
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('consent is 400 when consent is not a boolean', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/consent`,
        headers: { authorization: `Bearer ${token}` },
        payload: { consent: 'yes' }, // string, not boolean
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // POST /api/voice/:channelId/recording/start
  // =========================================================================

  it('start broadcasts RECORDING_STARTED and returns ok (200)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/start`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('start is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/start`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('start is 403 when caller lacks SPEAK_VOICE', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('muted');
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
        url: `/api/voice/${voiceChannelId}/recording/start`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // POST /api/voice/:channelId/recording/complete
  // =========================================================================

  it('complete creates a SessionRecording row (201) and returns the serialised record', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const attId = await makeAttachment(ownerId, 'audio');
    const startedAt = new Date('2024-01-01T10:00:00Z').toISOString();
    const endedAt = new Date('2024-01-01T11:00:00Z').toISOString();

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: { attachmentId: attId, startedAt, endedAt },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        channelId: string;
        attachmentId: string;
        recordedBy: string;
        startedAt: string;
        endedAt: string;
      }>;
      expect(body.data.channelId).toBe(voiceChannelId);
      expect(body.data.attachmentId).toBe(attId);
      expect(body.data.recordedBy).toBe(ownerId);
      expect(body.data.startedAt).toBe(startedAt);
      expect(body.data.endedAt).toBe(endedAt);

      const row = await prisma.sessionRecording.findUnique({ where: { id: body.data.id } });
      expect(row).not.toBeNull();
      expect(row?.recordedBy).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('complete works with a video attachment (201)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const attId = await makeAttachment(ownerId, 'video');
    const startedAt = new Date('2024-01-01T10:00:00Z').toISOString();
    const endedAt = new Date('2024-01-01T11:00:00Z').toISOString();

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: { attachmentId: attId, startedAt, endedAt },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const row = await prisma.sessionRecording.findUnique({ where: { id: body.data.id } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('complete is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const attId = await makeAttachment(ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        payload: {
          attachmentId: attId,
          startedAt: '2024-01-01T10:00:00Z',
          endedAt: '2024-01-01T11:00:00Z',
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('complete is 403 when caller lacks SPEAK_VOICE', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('muted');
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
    const attId = await makeAttachment(memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          attachmentId: attId,
          startedAt: '2024-01-01T10:00:00Z',
          endedAt: '2024-01-01T11:00:00Z',
        },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.sessionRecording.count({ where: { channelId: voiceChannelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('complete is 404 when the attachment does not belong to the caller', async () => {
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    const { serverId, voiceChannelId } = await makeServer(ownerId);
    await addMember(serverId, otherId);
    // Attachment owned by ownerId, but otherId calls complete
    const attId = await makeAttachment(ownerId, 'audio');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          attachmentId: attId,
          startedAt: '2024-01-01T10:00:00Z',
          endedAt: '2024-01-01T11:00:00Z',
        },
      });
      expect(res.statusCode).toBe(404);
      const count = await prisma.sessionRecording.count({ where: { channelId: voiceChannelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('complete is 404 when the attachmentId does not exist at all', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          attachmentId: ulid(),
          startedAt: '2024-01-01T10:00:00Z',
          endedAt: '2024-01-01T11:00:00Z',
        },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('complete is 400 when the attachment kind is not audio/video (image rejected)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    // image kind should be rejected by the validation branch
    const attId = await makeAttachment(ownerId, 'image');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          attachmentId: attId,
          startedAt: '2024-01-01T10:00:00Z',
          endedAt: '2024-01-01T11:00:00Z',
        },
      });
      expect(res.statusCode).toBe(400);
      const count = await prisma.sessionRecording.count({ where: { channelId: voiceChannelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('complete is 400 when startedAt is not an ISO datetime string', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const attId = await makeAttachment(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          attachmentId: attId,
          startedAt: 'not-a-date',
          endedAt: '2024-01-01T11:00:00Z',
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('complete is 400 when attachmentId is missing', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/${voiceChannelId}/recording/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          startedAt: '2024-01-01T10:00:00Z',
          endedAt: '2024-01-01T11:00:00Z',
          // attachmentId omitted
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // GET /api/voice/:channelId/recordings
  // =========================================================================

  it('GET lists recordings for a channel (200), ordered by createdAt desc', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const att1 = await makeAttachment(ownerId, 'audio');
    const att2 = await makeAttachment(ownerId, 'video');
    const rec1 = await makeSessionRecording(voiceChannelId, ownerId, att1);
    // Short pause to ensure distinct createdAt ordering
    await new Promise((r) => setTimeout(r, 5));
    const rec2 = await makeSessionRecording(voiceChannelId, ownerId, att2);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${voiceChannelId}/recordings`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<
        Array<{
          id: string;
          channelId: string;
          attachmentId: string;
          recordedBy: string;
          startedAt: string;
          endedAt: string;
          createdAt: string;
        }>
      >;
      expect(body.ok).toBe(true);
      expect(body.data.length).toBe(2);
      // createdAt desc — rec2 was created later so it should be first
      expect(body.data[0]?.id).toBe(rec2);
      expect(body.data[1]?.id).toBe(rec1);
      expect(body.data.every((r) => r.channelId === voiceChannelId)).toBe(true);
      expect(typeof body.data[0]?.startedAt).toBe('string');
      expect(typeof body.data[0]?.endedAt).toBe('string');
      expect(typeof body.data[0]?.createdAt).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('GET returns empty array when channel has no recordings (200)', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${voiceChannelId}/recordings`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
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
        url: `/api/voice/${voiceChannelId}/recordings`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET is 404 when channel does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/voice/${ulid()}/recordings`,
        headers: { authorization: `Bearer ${token}` },
      });
      // VIEW_CHANNEL on unknown channel → 404
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // DELETE /api/recordings/:id
  // =========================================================================

  it('DELETE by the recorder removes the row (200) and returns the id', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const attId = await makeAttachment(ownerId);
    const recId = await makeSessionRecording(voiceChannelId, ownerId, attId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recordings/${recId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(recId);

      const row = await prisma.sessionRecording.findUnique({ where: { id: recId } });
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
    const attId = await makeAttachment(ownerId);
    const recId = await makeSessionRecording(voiceChannelId, ownerId, attId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recordings/${recId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);

      const row = await prisma.sessionRecording.findUnique({ where: { id: recId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE is 403 for a non-recorder member without MANAGE_CHANNELS', async () => {
    const ownerId = await makeUser('owner');
    const viewerId = await makeUser('viewer');
    const { serverId, voiceChannelId } = await makeServer(ownerId); // no MANAGE_CHANNELS
    await addMember(serverId, viewerId);
    const attId = await makeAttachment(ownerId);
    const recId = await makeSessionRecording(voiceChannelId, ownerId, attId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recordings/${recId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);

      const row = await prisma.sessionRecording.findUnique({ where: { id: recId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE is 401 with no token', async () => {
    const ownerId = await makeUser('owner');
    const { voiceChannelId } = await makeServer(ownerId);
    const attId = await makeAttachment(ownerId);
    const recId = await makeSessionRecording(voiceChannelId, ownerId, attId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recordings/${recId}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('DELETE is 404 for an unknown recording id', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/recordings/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
