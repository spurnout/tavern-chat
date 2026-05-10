import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  Permission,
  TavernError,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const createEmojiBody = z.object({
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_]+$/i, 'Letters, numbers, and underscore only'),
  attachmentId: idSchema,
});

function serialize(e: {
  id: string;
  serverId: string;
  name: string;
  attachmentId: string;
  createdById: string | null;
  createdAt: Date;
}) {
  return {
    id: e.id,
    serverId: e.serverId,
    name: e.name,
    attachmentId: e.attachmentId,
    createdById: e.createdById,
    createdAt: e.createdAt.toISOString(),
  };
}

export async function registerEmojiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:serverId/emojis', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    // Membership check via server permission read
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const emojis = await prisma.customEmoji.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
    });
    reply.send(ok(emojis.map(serialize)));
  });

  app.post('/api/servers/:serverId/emojis', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = createEmojiBody.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_EMOJIS);

    const att = await prisma.attachment.findUnique({ where: { id: body.attachmentId } });
    if (!att || att.uploaderId !== ctx.userId || att.status !== 'ready') {
      throw TavernError.validation('Attachment must be uploaded and ready');
    }
    if (att.kind !== 'image' && att.kind !== 'gif') {
      throw TavernError.validation('Custom emojis must be image or gif');
    }

    const emoji = await prisma.customEmoji.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        attachmentId: body.attachmentId,
        createdById: ctx.userId,
      },
    });
    gatewayBroker.publish({ type: 'EMOJI_CREATE', serverId, data: serialize(emoji) });
    reply.status(201).send(ok(serialize(emoji)));
  });

  app.delete('/api/emojis/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const emoji = await prisma.customEmoji.findUnique({ where: { id } });
    if (!emoji) throw TavernError.notFound();
    await requireServerPermission(emoji.serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    await prisma.customEmoji.delete({ where: { id } });
    gatewayBroker.publish({ type: 'EMOJI_DELETE', serverId: emoji.serverId, data: { id } });
    reply.send(ok({ id }));
  });
}
