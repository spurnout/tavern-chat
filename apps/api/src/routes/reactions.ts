import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  Permission,
  reactionEmojiSchema,
  TavernError,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

export async function registerReactionRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/messages/:id/reactions/:emoji', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, emoji } = z
      .object({ id: idSchema, emoji: reactionEmojiSchema })
      .parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: { channelId: true, deletedAt: true, serverId: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound();
    await requireChannelPermission(message.channelId, ctx.userId, Permission.ADD_REACTIONS);

    if (emoji.startsWith('custom:')) {
      const emojiId = emoji.slice('custom:'.length);
      const custom = await prisma.customEmoji.findUnique({ where: { id: emojiId } });
      if (!custom || custom.serverId !== message.serverId) {
        throw TavernError.validation('Custom emoji unavailable in this channel');
      }
    }

    await prisma.messageReaction.upsert({
      where: { messageId_userId_emoji: { messageId: id, userId: ctx.userId, emoji } },
      create: { messageId: id, userId: ctx.userId, emoji },
      update: {},
    });
    gatewayBroker.publish({
      type: 'REACTION_ADD',
      serverId: message.serverId,
      channelId: message.channelId,
      data: { messageId: id, userId: ctx.userId, emoji },
    });
    reply.send(ok({ ok: true }));
  });

  app.delete('/api/messages/:id/reactions/:emoji', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, emoji } = z
      .object({ id: idSchema, emoji: reactionEmojiSchema })
      .parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: { channelId: true, deletedAt: true, serverId: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound();
    try {
      await prisma.messageReaction.delete({
        where: { messageId_userId_emoji: { messageId: id, userId: ctx.userId, emoji } },
      });
    } catch {
      /* idempotent */
    }
    gatewayBroker.publish({
      type: 'REACTION_REMOVE',
      serverId: message.serverId,
      channelId: message.channelId,
      data: { messageId: id, userId: ctx.userId, emoji },
    });
    reply.send(ok({ ok: true }));
  });
}
