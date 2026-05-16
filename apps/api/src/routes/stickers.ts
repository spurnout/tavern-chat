import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const createBodySchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/, {
    message: 'Sticker names use lowercase letters, digits, hyphen, and underscore only',
  }),
  attachmentId: idSchema,
});

/**
 * Wave 3 #3 — server stickers. Static image stickers (separate from emoji
 * which render inline at 18px; stickers render at ~96px as their own block).
 * Auth: anyone can list. Upload + delete require MANAGE_EMOJIS, which is the
 * canonical "tavern art assets" permission.
 */
export async function registerStickerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/stickers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const rows = await prisma.sticker.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });
    reply.send(
      ok(
        rows.map((s) => ({
          id: s.id,
          serverId: s.serverId,
          name: s.name,
          attachmentId: s.attachmentId,
          uploadedBy: s.uploadedBy,
          position: s.position,
          createdAt: s.createdAt.toISOString(),
        })),
      ),
    );
  });

  app.post('/api/servers/:id/stickers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createBodySchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_EMOJIS);

    const att = await prisma.attachment.findUnique({
      where: { id: body.attachmentId },
      select: { kind: true, status: true },
    });
    if (!att) throw TavernError.notFound('Attachment not found');
    if (att.kind !== 'image' && att.kind !== 'gif') {
      throw TavernError.validation('Stickers must be image or gif attachments');
    }
    if (att.status !== 'ready') {
      throw new TavernError('UPLOAD_NOT_READY', 'Attachment not ready', 400);
    }

    const maxPos = await prisma.sticker.aggregate({
      where: { serverId },
      _max: { position: true },
    });
    const sticker = await prisma.sticker.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        attachmentId: body.attachmentId,
        uploadedBy: ctx.userId,
        position: (maxPos._max.position ?? -1) + 1,
      },
    });
    reply.status(201).send(
      ok({
        id: sticker.id,
        serverId: sticker.serverId,
        name: sticker.name,
        attachmentId: sticker.attachmentId,
        uploadedBy: sticker.uploadedBy,
        position: sticker.position,
        createdAt: sticker.createdAt.toISOString(),
      }),
    );
  });

  app.delete('/api/stickers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const sticker = await prisma.sticker.findUnique({ where: { id } });
    if (!sticker) throw TavernError.notFound('Sticker not found');
    await requireServerPermission(sticker.serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    await prisma.sticker.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
