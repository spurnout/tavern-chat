import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import { loadThreadSummaryForRootId } from '../lib/thread-summary.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * Prisma include block used to hydrate a thread-root message for a broadcast.
 * Mirrors the include shapes used in messages.ts so `serializeMessage` has
 * everything it needs.
 */
const ROOT_MESSAGE_INCLUDE = {
  attachments: { select: { id: true } },
  reactions: { select: { emoji: true, userId: true } },
  author: { select: { id: true, displayName: true, username: true } },
  diceRoll: { select: { resultJson: true, label: true } },
  poll: { select: { id: true } },
  replyTo: {
    select: {
      id: true,
      content: true,
      deletedAt: true,
      author: { select: { displayName: true } },
    },
  },
  forwardedFrom: {
    select: {
      id: true,
      channelId: true,
      author: { select: { displayName: true } },
    },
  },
} as const;

/**
 * Re-broadcast a thread-root message with its current threadSummary so chat
 * clients refresh the "N replies" badge live. Best-effort: a failure here
 * never fails the originating HTTP request — the local row and thread are
 * already committed.
 */
async function broadcastRootMessageUpdate(
  rootMessageId: string,
  viewerId: string,
): Promise<void> {
  const row = await prisma.message.findUnique({
    where: { id: rootMessageId },
    include: ROOT_MESSAGE_INCLUDE,
  });
  if (!row || row.deletedAt) return;
  const threadSummary = await loadThreadSummaryForRootId(rootMessageId);
  const dto = serializeMessage(
    { ...(row as MessageRow), threadSummary },
    viewerId,
  );
  gatewayBroker.publish({
    type: 'MESSAGE_UPDATE',
    serverId: row.serverId ?? undefined,
    channelId: row.channelId ?? undefined,
    data: dto,
  });
}

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

  // ---- Fetch a single thread --------------------------------------------
  // Lets the thread side-panel resolve its own title in one O(1) round-trip
  // (and without a root message to anchor on), instead of pulling the whole
  // channel thread list and filtering client-side.
  app.get('/api/threads/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const thread = await prisma.thread.findUnique({ where: { id } });
    if (!thread) throw TavernError.notFound('Thread not found');
    await requireChannelPermission(thread.channelId, ctx.userId, Permission.VIEW_CHANNEL);
    reply.send(ok(serializeThread(thread)));
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
          // Strip any HTML from the title for parity with message content
          // (defense-in-depth: titles are rendered as text today, but may be
          // surfaced elsewhere or shipped over federation).
          title: body.title ? sanitizeContent(body.title) : null,
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
    // Refresh the root message in every connected client's cache so the
    // chat view picks up `isThreadRoot=true` and renders the "N replies"
    // footer immediately, without needing a channel refetch.
    await broadcastRootMessageUpdate(messageId, ctx.userId).catch((err: unknown) => {
      const errObj = err instanceof Error ? err : new Error(String(err));
      app.log.warn(
        { err: errObj, rootMessageId: messageId, channelId },
        'thread-root broadcast failed after thread create (thread already committed)',
      );
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
        ...(body.title !== undefined ? { title: sanitizeContent(body.title) } : {}),
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
        diceRoll: { select: { resultJson: true, label: true } },
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
          diceRoll: { select: { resultJson: true, label: true } },
        },
      });
      if (existing) {
        if (
          existing.authorId !== ctx.userId ||
          existing.threadId !== id ||
          existing.deletedAt !== null
        ) {
          throw TavernError.validation('Nonce already used');
        }
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
          diceRoll: { select: { resultJson: true, label: true } },
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
    // Bump the root message broadcast so the chat view's thread footer
    // re-renders with the new reply count and lastActivityAt.
    await broadcastRootMessageUpdate(thread.rootMessageId, ctx.userId).catch((err: unknown) => {
      const errObj = err instanceof Error ? err : new Error(String(err));
      app.log.warn(
        { err: errObj, rootMessageId: thread.rootMessageId, channelId: thread.channelId },
        'thread-root broadcast failed after thread reply (reply already committed)',
      );
    });
    reply.status(201).send(ok(dto));
  });
}
