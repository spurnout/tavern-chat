import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * Activity inbox + unread state.
 *
 * The unread model is a single read cursor per (user, channel). Messages
 * with id > lastReadMessageId are unread (ULIDs sort lexically by time, so
 * lexical comparison is equivalent to time comparison).
 *
 * The activity inbox is a list of UserMention rows where isRead=false. The
 * cached `mentionCount` on UserChannelReadState is the bell badge total
 * across all channels (sum it client-side).
 */

const ackBodySchema = z.object({
  lastReadMessageId: z.string().min(1),
});

const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  /** Filter — `unread` (default) or `all`. */
  filter: z.enum(['unread', 'all']).default('unread'),
});

export async function registerInboxRoutes(app: FastifyInstance): Promise<void> {
  // ---- Per-channel ack ---------------------------------------------------
  app.post('/api/channels/:id/ack', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = ackBodySchema.parse(req.body);

    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);

    const state = await prisma.userChannelReadState.upsert({
      where: { userId_channelId: { userId: ctx.userId, channelId } },
      create: {
        userId: ctx.userId,
        channelId,
        lastReadMessageId: body.lastReadMessageId,
        mentionCount: 0,
      },
      update: {
        lastReadMessageId: body.lastReadMessageId,
        lastReadAt: new Date(),
        mentionCount: 0,
      },
    });

    // Mark all unread mentions in this channel as read.
    await prisma.userMention.updateMany({
      where: {
        userId: ctx.userId,
        channelId,
        isRead: false,
      },
      data: { isRead: true },
    });

    // Notify the user's other sessions so multiple tabs stay in sync.
    gatewayBroker.publish({
      type: 'MESSAGE_ACK',
      userId: ctx.userId,
      data: {
        channelId,
        lastReadMessageId: body.lastReadMessageId,
        lastReadAt: state.lastReadAt.toISOString(),
      },
    });

    reply.send(
      ok({
        channelId,
        lastReadMessageId: state.lastReadMessageId,
        lastReadAt: state.lastReadAt.toISOString(),
        mentionCount: state.mentionCount,
      }),
    );
  });

  // ---- Read-state list ---------------------------------------------------
  // Returns the caller's read state for every channel they've ever read,
  // plus the channel's most recent message id so the client can compute
  // "is there anything unread?".
  app.get('/api/me/read-states', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const states = await prisma.userChannelReadState.findMany({
      where: { userId: ctx.userId },
      select: {
        channelId: true,
        lastReadMessageId: true,
        lastReadAt: true,
        mentionCount: true,
      },
    });
    reply.send(
      ok(
        states.map((s) => ({
          channelId: s.channelId,
          lastReadMessageId: s.lastReadMessageId,
          lastReadAt: s.lastReadAt.toISOString(),
          mentionCount: s.mentionCount,
        })),
      ),
    );
  });

  // ---- Activity inbox ----------------------------------------------------
  app.get('/api/me/inbox', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const query = inboxQuerySchema.parse(req.query);

    const where = {
      userId: ctx.userId,
      ...(query.filter === 'unread' ? { isRead: false } : {}),
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };

    const rows = await prisma.userMention.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit,
      include: {
        message: {
          select: {
            id: true,
            channelId: true,
            dmChannelId: true,
            authorId: true,
            content: true,
            createdAt: true,
            author: { select: { id: true, displayName: true, username: true } },
          },
        },
      },
    });

    reply.send(
      ok({
        items: rows.map((m) => ({
          id: m.id,
          kind: m.kind,
          isRead: m.isRead,
          createdAt: m.createdAt.toISOString(),
          channelId: m.channelId,
          dmChannelId: m.dmChannelId,
          message: {
            id: m.message.id,
            channelId: m.message.channelId,
            dmChannelId: m.message.dmChannelId,
            authorId: m.message.authorId,
            authorDisplayName: m.message.author.displayName,
            content: m.message.content,
            createdAt: m.message.createdAt.toISOString(),
          },
        })),
        nextCursor: rows.length === query.limit ? rows[rows.length - 1]?.id : null,
      }),
    );
  });

  // ---- Single-mention ack -------------------------------------------------
  app.post('/api/me/inbox/:id/ack', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);

    const mention = await prisma.userMention.findUnique({
      where: { id },
      select: { id: true, userId: true, isRead: true, channelId: true },
    });
    if (!mention || mention.userId !== ctx.userId) {
      throw TavernError.notFound('Mention not found');
    }
    if (mention.isRead) {
      reply.send(ok({ id, isRead: true }));
      return;
    }
    await prisma.userMention.update({
      where: { id },
      data: { isRead: true },
    });
    if (mention.channelId) {
      await prisma.userChannelReadState.updateMany({
        where: {
          userId: ctx.userId,
          channelId: mention.channelId,
          mentionCount: { gt: 0 },
        },
        data: { mentionCount: { decrement: 1 } },
      });
    }
    reply.send(ok({ id, isRead: true }));
  });

  // ---- Ack-all -----------------------------------------------------------
  app.post('/api/me/inbox/ack-all', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    await prisma.userMention.updateMany({
      where: { userId: ctx.userId, isRead: false },
      data: { isRead: true },
    });
    await prisma.userChannelReadState.updateMany({
      where: { userId: ctx.userId, mentionCount: { gt: 0 } },
      data: { mentionCount: 0 },
    });
    reply.send(ok({ ok: true }));
  });
}
