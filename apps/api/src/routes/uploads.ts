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
import { UploadValidator } from '../services/upload-validator.js';
import type { QueueClient } from '../services/queues.js';
import type { Config } from '../config.js';

interface Deps {
  config: Config;
  storage: StorageBackend;
  queues: QueueClient;
}

export async function registerUploadRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { config: cfg, storage, queues } = deps;
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

    const presigned = await storage
      .presignPut(bucket, key, body.mimeType, body.sizeBytes)
      .catch((err) => {
        app.log.error({ err }, 'presign failed');
        throw new TavernError(ErrorCodes.INTERNAL_ERROR, 'Could not create upload URL', 500);
      });

    reply.status(201).send(
      ok({
        attachment: serializeAttachment(attachment as unknown as AttachmentRow, storage),
        upload: {
          method: 'PUT' as const,
          url: presigned.url,
          headers: presigned.headers,
          expiresAt: presigned.expiresAt.toISOString(),
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
    if (att.uploaderId !== ctx.userId) {
      if (att.channelId) {
        await requireChannelPermission(att.channelId, ctx.userId, Permission.VIEW_CHANNEL);
      } else if (!ctx.isInstanceAdmin) {
        throw TavernError.forbidden();
      }
    }
    reply.send(ok(serializeAttachment(att as unknown as AttachmentRow, storage)));
  });
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-128);
}
