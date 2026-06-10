import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  completeUploadRequestSchema,
  ErrorCodes,
  idSchema,
  Permission,
  requestUploadRequestSchema,
  TavernError,
  ulid,
} from '@tavern/shared';
import type { StorageBackend } from '@tavern/media';
import { ok } from '../lib/responses.js';
import { serializeAttachment, type AttachmentRow } from '../lib/serializers.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { requireDmChannelMembership } from '../services/dm-service.js';
import { UploadValidator } from '../services/upload-validator.js';
import type { UploadGovernor } from '../services/upload-governor.js';
import type { QueueClient } from '../services/queues.js';
import type { Config } from '../config.js';

interface Deps {
  config: Config;
  storage: StorageBackend;
  queues: QueueClient;
  uploadGovernor: UploadGovernor;
}

export async function registerUploadRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { config: cfg, storage, queues, uploadGovernor } = deps;
  const validator = new UploadValidator(cfg);

  storage.ensureBuckets().catch((err) => {
    app.log.error({ err }, 'failed to ensure storage buckets');
  });

  // Request a presigned upload URL.
  app.post('/api/uploads', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = requestUploadRequestSchema.parse(req.body);

    const me = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { uploadsLockedUntil: true },
    });
    if (me?.uploadsLockedUntil && me.uploadsLockedUntil > new Date()) {
      throw new TavernError('CONTENT_HELD', 'Your upload privileges are temporarily locked', 403);
    }

    if (body.channelId) {
      const flag =
        body.kind === 'voice_message' ? Permission.SEND_VOICE_MESSAGES : Permission.ATTACH_FILES;
      await requireChannelPermission(body.channelId, ctx.userId, flag);
    }

    validator.validate({
      kind: body.kind,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    });

    const voiceActive = await uploadGovernor.shouldThrottleUpload();
    const id = ulid();
    const key = `${ctx.userId}/${id}/${sanitizeFilename(body.filename)}`;
    const bucket = storage.bucketFor(false);

    const attachment = await prisma.attachment.create({
      data: {
        id,
        uploaderId: ctx.userId,
        serverId: body.serverId ?? null,
        channelId: body.channelId ?? null,
        kind: body.kind,
        filename: body.filename,
        mimeType: body.mimeType,
        sizeBytes: BigInt(body.sizeBytes),
        storageBucket: bucket,
        storageKey: key,
        status: 'pending',
      },
    });

    const upload = voiceActive
      ? uploadGovernor.createGovernedTicket({
          bucket,
          key,
          mimeType: body.mimeType,
          sizeBytes: body.sizeBytes,
        })
      : {
          ...(await storage
            .presignPut(bucket, key, body.mimeType, body.sizeBytes)
            .catch((err) => {
              app.log.error({ err }, 'presign failed');
              throw new TavernError(ErrorCodes.INTERNAL_ERROR, 'Could not create upload URL', 500);
            })),
          strategy: 'direct' as const,
          voiceActive: false,
        };

    reply.status(201).send(
      ok({
        attachment: serializeAttachment(attachment as unknown as AttachmentRow, storage),
        upload: {
          method: 'PUT' as const,
          url: upload.url,
          headers: upload.headers,
          expiresAt: upload.expiresAt.toISOString(),
          strategy: upload.strategy,
          voiceActive: upload.voiceActive,
          ...(upload.strategy === 'tavern_throttled'
            ? { maxBytesPerSecond: upload.maxBytesPerSecond }
            : {}),
        },
      }),
    );
  });

  // Mark an upload complete; enqueue scan job (or run it in-process).
  app.post('/api/uploads/:id/complete', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = completeUploadRequestSchema.parse({ ...(req.body as object), attachmentId: id });

    const att = await prisma.attachment.findUnique({ where: { id: body.attachmentId } });
    if (!att) throw TavernError.notFound();
    if (att.uploaderId !== ctx.userId) throw TavernError.forbidden();
    if (att.status !== 'pending') {
      throw new TavernError(ErrorCodes.VALIDATION_ERROR, 'Attachment already finalised', 400);
    }

    let stat: { size: number; etag: string };
    try {
      stat = await storage.statObject(att.storageBucket, att.storageKey);
    } catch {
      throw new TavernError(ErrorCodes.UPLOAD_NOT_READY, 'Object not found in storage', 400);
    }
    if (BigInt(stat.size) !== att.sizeBytes) {
      throw new TavernError(
        ErrorCodes.VALIDATION_ERROR,
        'Uploaded size does not match declared size',
        400,
      );
    }

    const updated = await prisma.attachment.update({
      where: { id: att.id },
      data: { status: 'uploaded' },
    });

    queues.enqueueScan(att.id).catch((err: unknown) => {
      app.log.error({ err, attachmentId: att.id }, 'failed to enqueue scan job');
    });

    reply.send(ok(serializeAttachment(updated as unknown as AttachmentRow, storage)));
  });

  // Client-computed waveform for voice messages.
  app.post('/api/attachments/:id/waveform', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const params = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({
        peaks: z.array(z.number().int().min(0).max(255)).min(8).max(128),
        durationMs: z.number().int().nonnegative().max(15 * 60 * 1000).optional(),
      })
      .parse(req.body);

    const att = await prisma.attachment.findUnique({ where: { id: params.id } });
    if (!att) throw TavernError.notFound();
    if (att.uploaderId !== ctx.userId) throw TavernError.forbidden();
    if (att.kind !== 'voice_message') {
      throw new TavernError(ErrorCodes.VALIDATION_ERROR, 'Not a voice message', 400);
    }
    if (att.status !== 'uploaded' && att.status !== 'processing' && att.status !== 'ready') {
      throw new TavernError(
        ErrorCodes.VALIDATION_ERROR,
        'Cannot set waveform before the voice message is uploaded',
        400,
      );
    }

    const updated = await prisma.attachment.update({
      where: { id: params.id },
      data: {
        waveform: body.peaks,
        ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
      },
    });
    reply.send(ok(serializeAttachment(updated as unknown as AttachmentRow, storage)));
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const att = await prisma.attachment.findUnique({ where: { id } });
    if (!att) throw TavernError.notFound();

    // Quarantined / blocked attachments must not be visible to anyone except
    // the uploader and instance admins (for incident response). Return 404 to
    // viewers rather than 403 so the existence of the malicious upload isn't
    // confirmed to other channel members.
    const isOwnerOrAdmin = att.uploaderId === ctx.userId || ctx.isInstanceAdmin;
    if (!isOwnerOrAdmin && (att.status === 'quarantined' || att.status === 'blocked' || att.status === 'failed')) {
      throw TavernError.notFound();
    }

    if (att.uploaderId !== ctx.userId) {
      if (att.channelId) {
        await requireChannelPermission(att.channelId, ctx.userId, Permission.VIEW_CHANNEL);
      } else if (att.messageId) {
        // DM attachments are uploaded without a channel/server scope and only
        // get their `messageId` set when the DM message is sent. Fall through
        // to the linked message to figure out who is allowed to see it.
        const msg = await prisma.message.findUnique({
          where: { id: att.messageId },
          select: { channelId: true, dmChannelId: true },
        });
        if (msg?.channelId) {
          await requireChannelPermission(msg.channelId, ctx.userId, Permission.VIEW_CHANNEL);
        } else if (msg?.dmChannelId) {
          await requireDmChannelMembership(msg.dmChannelId, ctx.userId);
        } else if (!ctx.isInstanceAdmin) {
          throw TavernError.forbidden();
        }
      } else if (!ctx.isInstanceAdmin) {
        throw TavernError.forbidden();
      }
    }
    reply.send(ok(serializeAttachment(att as unknown as AttachmentRow, storage)));
  });
}

/**
 * Sanitize a user-supplied filename before it lands in storage. UPL-002.
 *
 * The output is restricted to a narrow ASCII alphabet (letters, digits,
 * underscore, dash, dot). Beyond what the original regex covered we also:
 *   - Strip null bytes (would otherwise truncate the name on some FS layers).
 *   - Normalize to NFC and strip the RTL-override + other bidi controls so
 *     the filename a user sees matches what's on disk.
 *   - Refuse Windows-reserved device names (CON, PRN, AUX, NUL, COM1-9,
 *     LPT1-9), case-insensitive, with or without an extension.
 *   - Strip trailing dots and spaces (Windows silently strips them, so
 *     `foo.exe.` would resolve to `foo.exe`).
 *   - Strip leading dots (prevents accidentally creating hidden files on
 *     POSIX hosts).
 *   - Fall back to a stable default when the sanitised name is empty,
 *     instead of returning "" and producing an empty storage key segment.
 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function sanitizeFilename(filename: string): string {
  let out = filename.normalize('NFC');
  // Strip control characters incl. null bytes (\x00-\x1F) and bidi overrides.
  // The subsequent allow-list regex would also strip them, but doing it first
  // means the regex never sees them and we can't accidentally allow one
  // through a future tweak.
  out = out.replace(/[ -‪-‮⁦-⁩]/g, '');
  out = out.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  out = out.replace(/^\.+/, '').replace(/[. ]+$/, '');
  // Reject Windows-reserved device names. Check the part before the first dot.
  const base = out.split('.')[0]?.toUpperCase() ?? '';
  if (WINDOWS_RESERVED.has(base)) out = `_${out}`;
  if (out.length === 0) out = 'upload';
  return out.slice(-128);
}
