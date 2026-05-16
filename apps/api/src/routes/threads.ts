import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const createBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
});

const patchBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
});

const threadMessageBodySchema = z.object({
  content: z.string().min(1).max(4000),
  nonce: z.string().min(1).max(64).optional(),
});

const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: idSchema.optional(),
});

function sanitizeContent(content: string): string {
  return sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} });
}

function serializeThread(t: {
  id: string;
  channelId: string;
  rootMessageId: string;
  title: string | null;
  archivedAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  createdBy: string;
}): {
  id: string;
  channelId: string;
  rootMessageId: string;
  title: string | null;
  archivedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  createdBy: string;
} {
  return {
    id: t.id,
    channelId: t.channelId,
    rootMessageId: t.rootMessageId,
    title: t.title,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    lastActivityAt: t.lastActivityAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    createdBy: t.createdBy,
  };
}

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  // ---- List threads in a channel ----------------------------------------
  app.get('/api/channels/:id/threads', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);

    const threads = await prisma.thread.findMany({
      where: { channelId },
      orderBy: { lastActivityAt: 'desc' },
      take: 50,
    });
    reply.send(ok(threads.map(serializeThread)));
  });

  // ---- Create a thread from a message ------------------------------------
  app.post('/api/channels/:id/messages/:messageId/threads', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId, messageId } = z
      .object({ id: idSchema, messageId: idSchema })
      .parse(req.params);
    const body = createBodySchema.parse(req.body ?? {});

    await requireChannelPermission(channelId, ctx.userId, Permission.SEND_MESSAGES);

    const root = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, deletedAt: true, isThreadRoot: true },
    });
    if (!root || root.channelId !== channelId || root.deletedAt) {
      throw TavernError.validation('Thread root invalid');
    }
    if (root.isThreadRoot) {
      const existing = await prisma.thread.findUnique({ where: { rootMessageId: messageId } });
      if (existing) {
        reply.status(200).send(ok(serializeThread(existing)));
        return;
      }
    }

    const threadId = ulid();
    const thread = await prisma.$transaction(async (tx) => {
      const t = await tx.thread.create({
        data: {
          id: threadId,
          channelId,
          rootMessageId: messageId,
          title: body.title ?? null,
          createdBy: ctx.userId,
        },
      });
      await tx.message.update({
        where: { id: messageId },
        data: { isThreadRoot: true },
      });
      return t;
    });

    gatewayBroker.publish({
      type: 'THREAD_CREATE',
      channelId,
      data: serializeThread(thread),
    });
    reply.status(201).send(ok(serializeThread(thread)));
  });

  // ---- Patch / archive ---------------------------------------------------
  app.patch('/api/threads/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = patchBodySchema.parse(req.body);

    const thread = await prisma.thread.findUnique({ where: { id } });
    if (!thread) throw TavernError.notFound('Thread not found');

    // Need MANAGE_MESSAGES on the parent channel, or be the thread creator.
    const isCreator = thread.createdBy === ctx.userId;
    if (!isCreator) {
      await requireChannelPermission(thread.channelId, ctx.userId, Permission.MANAGE_MESSAGES);
    } else {
      await requireChannelPermission(thread.channelId, ctx.userId, Permission.VIEW_CHANNEL);
    }

    const updated = await prisma.thread.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.archived === true ? { archivedAt: new Date() } : {}),
        ...(body.archived === false ? { archivedAt: null } : {}),
      },
    });

    if (body.archived === true) {
      gatewayBroker.publish({
        type: 'THREAD_ARCHIVE',
        channelId: updated.channelId,
        data: serializeThread(updated),
      });
    } else {
      gatewayBroker.publish({
        type: 'THREAD_UPDATE',
        channelId: updated.channelId,
        data: serializeThread(updated),
      });
    }

    reply.send(ok(serializeThread(updated)));
  });

  // ---- Thread message list ----------------------------------------------
  app.get('/api/threads/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const query = listMessagesQuerySchema.parse(req.query);

    const thread = await prisma.thread.findUnique({ where: { id } });
    if (!thread) throw TavernError.notFound('Thread not found');
    await requireChannelPermission(thread.channelId, ctx.userId, Permission.READ_MESSAGE_HISTORY);

    const messages = await prisma.message.findMany({
      where: {
        threadId: id,
        deletedAt: null,
        ...(query.before ? { id: { lt: query.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
        author: { select: { id: true, displayName: true, username: true } },
      },
    });

    reply.send(ok(messages.map((m: MessageRow) => serializeMessage(m, ctx.userId))));
  });

  // ---- Post a thread message --------------------------------------------
  app.post('/api/threads/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = threadMessageBodySchema.parse(req.body);

    const thread = await prisma.thread.findUnique({ where: { id } });
    if (!thread) throw TavernError.notFound('Thread not found');
    if (thread.archivedAt) throw TavernError.validation('Thread is archived');
    const result = await requireChannelPermission(
      thread.channelId,
      ctx.userId,
      Permission.SEND_MESSAGES,
    );

    if (body.nonce) {
      const existing = await prisma.message.findUnique({
        where: { channelId_nonce: { channelId: thread.channelId, nonce: body.nonce } },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
        },
      });
      if (existing) {
        reply.status(200).send(ok(serializeMessage(existing as MessageRow, ctx.userId)));
        return;
      }
    }

    const messageId = ulid();
    const clean = sanitizeContent(body.content);
    const row = await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: messageId,
          serverId: result.serverId,
          channelId: thread.channelId,
          authorId: ctx.userId,
          type: 'default',
          content: clean,
          threadId: id,
          nonce: body.nonce ?? null,
        },
      });
      await tx.thread.update({
        where: { id },
        data: { lastActivityAt: new Date() },
      });
      return tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
        },
      });
    });

    const dto = serializeMessage(row as MessageRow, ctx.userId);
    // Thread messages fan out on the same channelId so anyone in the room
    // sees the activity — the client uses `threadId` on the dto to route
    // it into the thread panel instead of the main feed.
    gatewayBroker.publish({
      type: 'MESSAGE_CREATE',
      serverId: result.serverId,
      channelId: thread.channelId,
      data: dto,
    });
    reply.status(201).send(ok(dto));
  });
}
