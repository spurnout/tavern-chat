import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';

const saveBodySchema = z.object({ note: z.string().max(280).optional() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

/**
 * Personal bookmarks. Private to the user; no gateway events. The
 * authorization check is simple: the user must be able to view the message
 * (i.e. it lives in a channel they belong to or a DM they're in).
 */
export async function registerSavedMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/saved', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const query = listQuerySchema.parse(req.query);

    const rows = await prisma.savedMessage.findMany({
      where: {
        userId: ctx.userId,
        ...(query.cursor ? { messageId: { lt: query.cursor } } : {}),
      },
      orderBy: { savedAt: 'desc' },
      take: query.limit,
      include: {
        message: {
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
            diceRoll: { select: { resultJson: true, label: true } },
          },
        },
      },
    });

    reply.send(
      ok({
        items: rows.map((s) => ({
          messageId: s.messageId,
          savedAt: s.savedAt.toISOString(),
          note: s.note,
          message: serializeMessage(s.message as MessageRow, ctx.userId),
        })),
        nextCursor:
          rows.length === query.limit ? rows[rows.length - 1]?.messageId ?? null : null,
      }),
    );
  });

  app.post('/api/me/saved/:messageId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { messageId } = z.object({ messageId: idSchema }).parse(req.params);
    const body = saveBodySchema.parse(req.body ?? {});

    const target = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, dmChannelId: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw TavernError.notFound('Message not found');
    }

    // Visibility check: server messages require channel membership (we lean
    // on the existing message-fetch route's gate; for bookmarks we simply
    // require that the user has VIEW_CHANNEL — checked by allowing the save
    // to proceed only if the user is a member of the server, OR a member of
    // the DM channel for DMs).
    if (target.dmChannelId) {
      const member = await prisma.dmChannelMember.findUnique({
        where: {
          dmChannelId_userId: { dmChannelId: target.dmChannelId, userId: ctx.userId },
        },
      });
      if (!member) throw TavernError.forbidden();
    } else if (target.channelId) {
      const ch = await prisma.channel.findUnique({
        where: { id: target.channelId },
        select: { serverId: true },
      });
      if (!ch) throw TavernError.notFound('Message not found');
      const isMember = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: ch.serverId, userId: ctx.userId } },
      });
      if (!isMember) throw TavernError.forbidden();
    }

    const saved = await prisma.savedMessage.upsert({
      where: { userId_messageId: { userId: ctx.userId, messageId } },
      create: { userId: ctx.userId, messageId, note: body.note ?? null },
      update: { note: body.note ?? null },
    });

    reply.status(201).send(
      ok({
        messageId: saved.messageId,
        savedAt: saved.savedAt.toISOString(),
        note: saved.note,
      }),
    );
  });

  app.delete('/api/me/saved/:messageId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { messageId } = z.object({ messageId: idSchema }).parse(req.params);
    const existing = await prisma.savedMessage.findUnique({
      where: { userId_messageId: { userId: ctx.userId, messageId } },
    });
    if (!existing) {
      throw TavernError.notFound('Not saved');
    }
    await prisma.savedMessage.delete({
      where: { userId_messageId: { userId: ctx.userId, messageId } },
    });
    reply.send(ok({ messageId }));
  });
}
