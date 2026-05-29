/**
 * Integration coverage for `apps/api/src/routes/uploads.ts` against a real
 * Postgres (testcontainer) + the in-process LocalStorageBackend.
 *
 * The existing `uploads.test.ts` exercises only the serializer policy at the
 * Prisma layer; this file drives the HTTP handlers end-to-end via
 * `app.inject` (storage backend = `local`, the default in tests).
 *
 * Endpoints exercised:
 *   POST /api/uploads                    request a presigned upload + create
 *                                        the pending Attachment row
 *   POST /api/uploads/:id/complete       finalise an uploaded object
 *   POST /api/attachments/:id/waveform   attach a client-computed waveform
 *   GET  /api/attachments/:id            fetch attachment metadata (+ the
 *                                        quarantine/visibility policy)
 *
 * For each: happy path, 401 (unauthenticated), 403 (no channel permission /
 * not the uploader / locked uploads), 404 (unknown id / quarantined hidden
 * from non-owner), and 400/413/415 (validation: bad mime, blocked
 * extension, oversize, size-mismatch on complete).
 *
 * The complete happy path needs `statObject` to find a real file on disk.
 * Rather than depend on another route's content-type parser, we write the
 * object straight to the local storage dir via a `LocalStorageBackend`
 * pointed at the same `dataDir`/buckets the app's `createStorage` uses, then
 * call `POST /complete`. `enqueueScan` is a `vi.fn()` so no worker/Redis is
 * needed.
 *
 * Federation is off so no route here touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { LocalStorageBackend } from '@tavern/media';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';

// One on-disk storage dir for the whole file. `createStorage` resolves
// LOCAL_STORAGE_DIR and uses S3_BUCKET / S3_QUARANTINE_BUCKET as the bucket
// names; we mirror those defaults so a hand-built LocalStorageBackend writes
// to exactly the path the upload route's `statObject` reads from.
const STORAGE_DIR = path.resolve(`./data/storage-it-uploads-${randomBytes(6).toString('hex')}`);
const MAIN_BUCKET = 'tavern-media';
const QUARANTINE_BUCKET = 'tavern-quarantine';

const diskStorage = new LocalStorageBackend({
  dataDir: STORAGE_DIR,
  mainBucket: MAIN_BUCKET,
  quarantineBucket: QUARANTINE_BUCKET,
  apiBaseUrl: 'http://localhost:3001',
});

/** Write `sizeBytes` of filler to the object's on-disk location. */
async function writeObject(bucket: string, key: string, sizeBytes: number): Promise<void> {
  await diskStorage.putObject(bucket, key, Buffer.alloc(sizeBytes, 1), 'application/octet-stream');
}

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
  diskStorage.close();
  try {
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  if (ctx) await stopPostgres(ctx);
});

async function makeUser(slug: string, opts?: { instanceAdmin?: boolean }): Promise<string> {
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
      isInstanceAdmin: opts?.instanceAdmin ?? false,
    },
  });
  return id;
}

/** Server with an @everyone role (default perms incl. ATTACH_FILES) + a text channel. */
async function makeServerWithChannel(
  ownerId: string,
): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Upload Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'general' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, channelId, everyoneId };
}

async function addMember(serverId: string, userId: string, roleId?: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
  if (roleId) {
    await prisma.serverMemberRole.create({ data: { serverId, userId, roleId } });
  }
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    // Pin the local storage dir for the whole file so the hand-built
    // LocalStorageBackend (diskStorage) writes objects where the app's
    // own storage backend will stat them on /complete.
    LOCAL_STORAGE_DIR: STORAGE_DIR,
  } as NodeJS.ProcessEnv;
}

const enqueueScan = vi.fn(async () => undefined);

async function buildTestApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envFor(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan,
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

type OkBody<T> = { ok: true; data: T };
type RequestUploadData = {
  attachment: { id: string; status: string; kind: string };
  upload: { method: 'PUT'; url: string; headers: Record<string, string> };
};

async function cleanup(): Promise<void> {
  await prisma.attachment.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.apiToken.deleteMany({});
  await prisma.serverMemberRole.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
}

// ============================================================================
// POST /api/uploads — request a presigned upload
// ============================================================================

describe.skipIf(!dockerOk)('uploads: POST /api/uploads (request presign)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    enqueueScan.mockClear();
    await cleanup();
  });

  it('creates a pending Attachment and returns a presigned PUT for a valid image', async () => {
    const userId = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'image',
          filename: 'photo.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
          serverId,
          channelId,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<RequestUploadData>;
      expect(body.data.attachment.status).toBe('pending');
      expect(body.data.upload.method).toBe('PUT');
      expect(body.data.upload.url).toContain('/api/_local-uploads/');

      // Pending Attachment row persisted with the declared metadata.
      const row = await prisma.attachment.findUnique({ where: { id: body.data.attachment.id } });
      expect(row).not.toBeNull();
      expect(row?.uploaderId).toBe(userId);
      expect(row?.status).toBe('pending');
      expect(row?.channelId).toBe(channelId);
      expect(row?.serverId).toBe(serverId);
      expect(Number(row?.sizeBytes)).toBe(2048);
      // url is null for a non-ready attachment.
      expect(body.data.attachment.kind).toBe('image');
    } finally {
      await app.close();
    }
  });

  it('allows a channel-less (DM-style) upload without a permission check', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'image', filename: 'a.png', mimeType: 'image/png', sizeBytes: 100 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<RequestUploadData>;
      const row = await prisma.attachment.findUnique({ where: { id: body.data.attachment.id } });
      expect(row?.channelId).toBeNull();
      expect(row?.serverId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('401s without authentication', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        payload: { kind: 'image', filename: 'a.png', mimeType: 'image/png', sizeBytes: 1 },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('403s when the caller lacks ATTACH_FILES on the target channel', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    // Add the outsider as a member, then deny ATTACH_FILES via an @everyone
    // channel overwrite so they can still VIEW but can't attach.
    await addMember(serverId, outsiderId, everyoneId);
    await prisma.permissionOverwrite.create({
      data: {
        id: ulid(),
        channelId,
        targetType: 'role',
        targetId: everyoneId,
        allow: new Prisma.Decimal(0),
        // deny ATTACH_FILES (1n << 3n = 8)
        deny: new Prisma.Decimal(8),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'image',
          filename: 'photo.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          channelId,
        },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.attachment.count({});
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('403s when the uploader is temporarily locked (uploadsLockedUntil in the future)', async () => {
    const userId = await makeUser('alice');
    await prisma.user.update({
      where: { id: userId },
      data: { uploadsLockedUntil: new Date(Date.now() + 3_600_000) },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'image', filename: 'a.png', mimeType: 'image/png', sizeBytes: 100 },
      });
      expect(res.statusCode).toBe(403);
      const json = res.json() as { error?: { code?: string } };
      expect(json.error?.code).toBe('CONTENT_HELD');
    } finally {
      await app.close();
    }
  });

  it('415s for an SVG (always blocked) and a blocked executable extension', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const svg = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'image', filename: 'x.svg', mimeType: 'image/svg+xml', sizeBytes: 100 },
      });
      expect(svg.statusCode).toBe(415);

      // .exe is blocked by default (BLOCK_EXECUTABLE_UPLOADS defaults true).
      const exe = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'file', filename: 'virus.exe', mimeType: 'application/octet-stream', sizeBytes: 100 },
      });
      expect(exe.statusCode).toBe(415);
      expect(await prisma.attachment.count({})).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('415s for a mime that does not match the requested kind', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        // kind=image but an audio mime → "Image type not allowed".
        payload: { kind: 'image', filename: 'song.png', mimeType: 'audio/mpeg', sizeBytes: 100 },
      });
      expect(res.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('413s when the declared size exceeds the per-kind limit', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        // MAX_IMAGE_BYTES = 25 MiB; declare 26 MiB.
        payload: { kind: 'image', filename: 'huge.png', mimeType: 'image/png', sizeBytes: 26 * 1024 * 1024 },
      });
      expect(res.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it('400s on a malformed body (missing fields / non-positive size)', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'image', filename: 'a.png', mimeType: 'image/png', sizeBytes: 0 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// POST /api/uploads/:id/complete
// ============================================================================

/** Drive POST /api/uploads to get a pending attachment + its upload ticket. */
async function requestUpload(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  authToken: string,
  overrides: Partial<{ kind: string; filename: string; mimeType: string; sizeBytes: number; channelId: string }> = {},
): Promise<RequestUploadData> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { authorization: `Bearer ${authToken}` },
    payload: {
      kind: 'image',
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 16,
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`requestUpload failed: ${res.statusCode} ${res.body}`);
  return (res.json() as OkBody<RequestUploadData>).data;
}

describe.skipIf(!dockerOk)('uploads: POST /api/uploads/:id/complete', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    enqueueScan.mockClear();
    await cleanup();
  });

  it('finalises a pending upload to status=uploaded and enqueues a scan (full flow)', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const sizeBytes = 16;
      const data = await requestUpload(app, token, { sizeBytes });

      // Write a file of EXACTLY the declared size to the object's on-disk
      // location so the route's statObject() matches att.sizeBytes.
      const pending = await prisma.attachment.findUniqueOrThrow({
        where: { id: data.attachment.id },
      });
      await writeObject(pending.storageBucket, pending.storageKey, sizeBytes);

      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${data.attachment.id}/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; status: string }>;
      expect(body.data.status).toBe('uploaded');

      const row = await prisma.attachment.findUnique({ where: { id: data.attachment.id } });
      expect(row?.status).toBe('uploaded');
      // The scan job was enqueued for this attachment.
      expect(enqueueScan).toHaveBeenCalledWith(data.attachment.id);
    } finally {
      await app.close();
    }
  });

  it('400s (UPLOAD_NOT_READY) when the object was never uploaded to storage', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const data = await requestUpload(app, token);
      // No PUT — the object isn't on disk, so statObject throws.
      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${data.attachment.id}/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const json = res.json() as { error?: { code?: string } };
      expect(json.error?.code).toBe('UPLOAD_NOT_READY');
      // Status unchanged; no scan enqueued.
      const row = await prisma.attachment.findUnique({ where: { id: data.attachment.id } });
      expect(row?.status).toBe('pending');
      expect(enqueueScan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('400s (VALIDATION_ERROR) when the stored size differs from the declared size', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const data = await requestUpload(app, token, { sizeBytes: 32 });
      // Write FEWER bytes than declared so statObject reports a size that
      // doesn't equal att.sizeBytes → the route's size-mismatch 400.
      const pending = await prisma.attachment.findUniqueOrThrow({
        where: { id: data.attachment.id },
      });
      await writeObject(pending.storageBucket, pending.storageKey, 8);

      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${data.attachment.id}/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const json = res.json() as { error?: { code?: string } };
      expect(json.error?.code).toBe('VALIDATION_ERROR');
      const row = await prisma.attachment.findUnique({ where: { id: data.attachment.id } });
      expect(row?.status).toBe('pending');
    } finally {
      await app.close();
    }
  });

  it('404s when the attachment id does not exist', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${ulid()}/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('403s when a different user tries to complete the upload', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const app = await buildTestApp();
    try {
      const aliceToken = await mintToken(aliceId);
      const bobToken = await mintToken(bobId);
      const data = await requestUpload(app, aliceToken);
      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${data.attachment.id}/complete`,
        headers: { authorization: `Bearer ${bobToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('400s when the attachment was already finalised (status != pending)', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const data = await requestUpload(app, token);
      // Flip it out of `pending` directly.
      await prisma.attachment.update({
        where: { id: data.attachment.id },
        data: { status: 'uploaded' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${data.attachment.id}/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('401s without authentication', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/uploads/${ulid()}/complete`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// POST /api/attachments/:id/waveform
// ============================================================================

describe.skipIf(!dockerOk)('uploads: POST /api/attachments/:id/waveform', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  async function makeAttachment(
    uploaderId: string,
    over: Partial<{ kind: string; status: string }> = {},
  ): Promise<string> {
    const id = ulid();
    await prisma.attachment.create({
      data: {
        id,
        uploaderId,
        kind: over.kind ?? 'voice_message',
        filename: 'note.ogg',
        mimeType: 'audio/ogg',
        sizeBytes: BigInt(1024),
        storageBucket: 'tavern-media',
        storageKey: `${uploaderId}/${id}/note.ogg`,
        status: over.status ?? 'ready',
      },
    });
    return id;
  }

  it('stores peaks + duration on a voice-message attachment owned by the caller', async () => {
    const userId = await makeUser('alice');
    const attId = await makeAttachment(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const peaks = Array.from({ length: 16 }, (_v, i) => (i * 7) % 256);
      const res = await app.inject({
        method: 'POST',
        url: `/api/attachments/${attId}/waveform`,
        headers: { authorization: `Bearer ${token}` },
        payload: { peaks, durationMs: 4200 },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(row?.waveform).toEqual(peaks);
      expect(row?.durationMs).toBe(4200);
    } finally {
      await app.close();
    }
  });

  it('403s when the caller is not the uploader', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const attId = await makeAttachment(aliceId);
    const app = await buildTestApp();
    try {
      const bobToken = await mintToken(bobId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/attachments/${attId}/waveform`,
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { peaks: [1, 2, 3, 4, 5, 6, 7, 8] },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('400s when the attachment is not a voice message', async () => {
    const userId = await makeUser('alice');
    const attId = await makeAttachment(userId, { kind: 'image' });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/attachments/${attId}/waveform`,
        headers: { authorization: `Bearer ${token}` },
        payload: { peaks: [1, 2, 3, 4, 5, 6, 7, 8] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('400s when peaks are out of range / too few', async () => {
    const userId = await makeUser('alice');
    const attId = await makeAttachment(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      // Fewer than the min(8) peaks → zod rejects.
      const res = await app.inject({
        method: 'POST',
        url: `/api/attachments/${attId}/waveform`,
        headers: { authorization: `Bearer ${token}` },
        payload: { peaks: [1, 2, 3] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('404s for an unknown attachment id', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/attachments/${ulid()}/waveform`,
        headers: { authorization: `Bearer ${token}` },
        payload: { peaks: [1, 2, 3, 4, 5, 6, 7, 8] },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('401s without authentication', async () => {
    const userId = await makeUser('alice');
    const attId = await makeAttachment(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/attachments/${attId}/waveform`,
        payload: { peaks: [1, 2, 3, 4, 5, 6, 7, 8] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// GET /api/attachments/:id
// ============================================================================

describe.skipIf(!dockerOk)('uploads: GET /api/attachments/:id', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  async function makeAttachment(
    uploaderId: string,
    over: Partial<{ status: string; channelId: string | null; serverId: string | null }> = {},
  ): Promise<string> {
    const id = ulid();
    await prisma.attachment.create({
      data: {
        id,
        uploaderId,
        serverId: over.serverId ?? null,
        channelId: over.channelId ?? null,
        kind: 'image',
        filename: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: BigInt(1024),
        storageBucket: over.status === 'quarantined' ? 'tavern-quarantine' : 'tavern-media',
        storageKey: `${uploaderId}/${id}/photo.png`,
        status: over.status ?? 'ready',
      },
    });
    return id;
  }

  it('returns metadata to the uploader', async () => {
    const userId = await makeUser('alice');
    const attId = await makeAttachment(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; url: string | null }>;
      expect(body.data.id).toBe(attId);
      // ready → public url is materialised.
      expect(body.data.url).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('lets a channel member view a ready attachment scoped to that channel', async () => {
    const ownerId = await makeUser('owner');
    const viewerId = await makeUser('viewer');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, viewerId, everyoneId);
    const attId = await makeAttachment(ownerId, { channelId, serverId });
    const app = await buildTestApp();
    try {
      const viewerToken = await mintToken(viewerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('404s a channel-scoped attachment for a non-member (VIEW_CHANNEL → not found)', async () => {
    const ownerId = await makeUser('owner');
    const strangerId = await makeUser('stranger');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const attId = await makeAttachment(ownerId, { channelId, serverId });
    const app = await buildTestApp();
    try {
      const strangerToken = await mintToken(strangerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      // requireChannelPermission(VIEW_CHANNEL) returns 404 to avoid leaking existence.
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('hides a quarantined attachment from a non-owner (404) but shows the uploader', async () => {
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    const attId = await makeAttachment(ownerId, { status: 'quarantined' });
    const app = await buildTestApp();
    try {
      const otherToken = await mintToken(otherId);
      const hidden = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(hidden.statusCode).toBe(404);

      // The uploader can still see their own quarantined attachment.
      const ownerToken = await mintToken(ownerId);
      const visible = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(visible.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('lets an instance admin see a quarantined attachment they did not upload', async () => {
    const ownerId = await makeUser('owner');
    const adminId = await makeUser('admin', { instanceAdmin: true });
    const attId = await makeAttachment(ownerId, { status: 'quarantined' });
    const app = await buildTestApp();
    try {
      const adminToken = await mintToken(adminId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('403s a non-admin viewing a ready attachment with neither channel nor message scope', async () => {
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    // ready, but no channelId and no messageId → falls through to the
    // non-admin forbidden branch for anyone who isn't the uploader.
    const attId = await makeAttachment(ownerId, { status: 'ready' });
    const app = await buildTestApp();
    try {
      const otherToken = await mintToken(otherId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('404s for an unknown attachment id', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/attachments/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('401s without authentication', async () => {
    const userId = await makeUser('alice');
    const attId = await makeAttachment(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/attachments/${attId}` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
