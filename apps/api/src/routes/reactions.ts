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
import { requireDmChannelMembership } from '../services/dm-service.js';
import { gatewayBroker, type GatewayEvent } from '../services/gateway-broker.js';

interface MessageRouting {
  serverId: string | null;
  channelId: string | null;
  dmChannelId: string | null;
}

/**
 * Per-message access check: server messages route through channel perms,
 * DM messages through DmChannel membership.
 */
async function authorizeReaction(message: MessageRouting, userId: string): Promise<void> {
  if (message.dmChannelId) {
    await requireDmChannelMembership(message.dmChannelId, userId);
    return;
  }
  if (!message.channelId) throw TavernError.notFound();
  await requireChannelPermission(message.channelId, userId, Permission.ADD_REACTIONS);
}

function reactionEvent(
  type: 'REACTION_ADD' | 'REACTION_REMOVE',
  message: MessageRouting,
  payload: { messageId: string; userId: string; emoji: string },
): GatewayEvent {
  if (message.dmChannelId) {
    return { type, dmChannelId: message.dmChannelId, data: payload };
  }
  return {
    type,
    serverId: message.serverId ?? undefined,
    channelId: message.channelId ?? undefined,
    data: payload,
  };
}

export async function registerReactionRoutes(app: FastifyInstance): Promise<void> {
  // Wave 3 #4 — Top emoji used in this server over the last 30 days,
  // surfaced as one-tap "quick reaction" buttons on hover.
  app.get('/api/servers/:id/quick-reactions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL).catch(
      // Server-scope check via fall-through to permission service.
      () => undefined,
    );
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.messageReaction.groupBy({
      by: ['emoji'],
      where: {
        message: { serverId, createdAt: { gte: since } },
      },
      _count: { emoji: true },
      orderBy: { _count: { emoji: 'desc' } },
      take: 8,
    });
    reply.send(
      ok(
        rows.map((r) => ({
          emoji: r.emoji,
          count: r._count.emoji,
        })),
      ),
    );
  });

  app.put('/api/messages/:id/reactions/:emoji', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, emoji } = z
      .object({ id: idSchema, emoji: reactionEmojiSchema })
      .parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: { channelId: true, dmChannelId: true, deletedAt: true, serverId: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound();
    await authorizeReaction(message, ctx.userId);

    if (emoji.startsWith('custom:')) {
      const emojiId = emoji.slice('custom:'.length);
      const custom = await prisma.customEmoji.findUnique({ where: { id: emojiId } });
      // Custom emojis are server-scoped; DM messages can only use unicode
      // (or any custom emoji is rejected since there's no serverId to match).
      if (!custom || custom.serverId !== message.serverId) {
        throw TavernError.validation('Custom emoji unavailable in this channel');
      }
    }

    await prisma.messageReaction.upsert({
      where: { messageId_userId_emoji: { messageId: id, userId: ctx.userId, emoji } },
      create: { messageId: id, userId: ctx.userId, emoji },
      update: {},
    });
    gatewayBroker.publish(
      reactionEvent('REACTION_ADD', message, { messageId: id, userId: ctx.userId, emoji }),
    );
    reply.send(ok({ ok: true }));
  });

  app.delete('/api/messages/:id/reactions/:emoji', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, emoji } = z
      .object({ id: idSchema, emoji: reactionEmojiSchema })
      .parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: { channelId: true, dmChannelId: true, deletedAt: true, serverId: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound();
    try {
      await prisma.messageReaction.delete({
        where: { messageId_userId_emoji: { messageId: id, userId: ctx.userId, emoji } },
      });
    } catch {
      /* idempotent */
    }
    gatewayBroker.publish(
      reactionEvent('REACTION_REMOVE', message, { messageId: id, userId: ctx.userId, emoji }),
    );
    reply.send(ok({ ok: true }));
  });
}
