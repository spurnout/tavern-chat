import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import {
  createMessageRequestSchema,
  idSchema,
  listMessagesQuerySchema,
  Permission,
  TavernError,
  ulid,
  updateMessageRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import {
  getChannelPermissions,
  requireChannelPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * Server-side content sanitiser. Tavern stores raw user text and does its
 * actual HTML rendering on the client, but we still strip outright HTML to
 * prevent inadvertent injection if someone displays content unsafely.
 *
 * No tags, no attributes, no scripts. Plain text only.
 */
function sanitizeContent(content: string): string {
  return sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} });
}

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  // List messages in a channel ---------------------------------------------
  app.get('/api/channels/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.READ_MESSAGE_HISTORY);

    const query = listMessagesQuerySchema.parse(req.query);

    const where = {
      channelId,
      deletedAt: null,
      ...(query.before ? { id: { lt: query.before } } : {}),
      ...(query.after ? { id: { gt: query.after } } : {}),
    };

    const messages = await prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit,
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
      },
    });

    reply.send(ok(messages.map((m: MessageRow) => serializeMessage(m, ctx.userId))));
  });

  // Create a message --------------------------------------------------------
  app.post('/api/channels/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = createMessageRequestSchema.parse(req.body);

    const result = await requireChannelPermission(channelId, ctx.userId, Permission.SEND_MESSAGES);

    // Posting lock check (Phase 2 trust & safety integration).
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { postingLockedUntil: true },
    });
    if (user?.postingLockedUntil && user.postingLockedUntil > new Date()) {
      throw new TavernError('CONTENT_HELD', 'Your posting privileges are temporarily locked', 403);
    }

    // Idempotency via nonce: if the same (channelId, nonce) was used recently,
    // return the existing message.
    if (body.nonce) {
      const existing = await prisma.message.findUnique({
        where: { channelId_nonce: { channelId, nonce: body.nonce } },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
        },
      });
      if (existing) {
        reply.status(200).send(ok(serializeMessage(existing as MessageRow, ctx.userId)));
        return;
      }
    }

    if (body.replyToMessageId) {
      const target = await prisma.message.findUnique({
        where: { id: body.replyToMessageId },
        select: { channelId: true, deletedAt: true },
      });
      if (!target || target.channelId !== channelId || target.deletedAt) {
        throw TavernError.validation('Reply target invalid');
      }
    }

    // Validate attachment ownership + readiness.
    if (body.attachmentIds?.length) {
      if (
        (result.perms & Permission.ATTACH_FILES) !== Permission.ATTACH_FILES &&
        (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR
      ) {
        throw TavernError.forbidden('You cannot attach files in this channel');
      }
      const atts = await prisma.attachment.findMany({
        where: { id: { in: body.attachmentIds } },
        select: { id: true, uploaderId: true, status: true, messageId: true },
      });
      if (atts.length !== body.attachmentIds.length) {
        throw TavernError.validation('Unknown attachment');
      }
      for (const a of atts) {
        if (a.uploaderId !== ctx.userId) throw TavernError.forbidden('Attachment owned by another user');
        if (a.messageId !== null) throw TavernError.validation('Attachment already used');
        if (a.status !== 'ready' && a.status !== 'uploaded') {
          throw new TavernError('UPLOAD_NOT_READY', 'Attachment not ready', 400);
        }
      }
    }

    const messageId = ulid();
    const cleanContent = sanitizeContent(body.content);
    // DB-004: do the include-fetch inside the transaction after attachments
    // are linked, eliminating the prior post-commit findUnique round-trip
    // (which was a hot-path extra DB hit on every message send).
    const fullRow = await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: messageId,
          serverId: result.serverId,
          channelId,
          authorId: ctx.userId,
          type: 'default',
          content: cleanContent,
          replyToMessageId: body.replyToMessageId ?? null,
          nonce: body.nonce ?? null,
        },
      });
      if (body.attachmentIds?.length) {
        await tx.attachment.updateMany({
          where: { id: { in: body.attachmentIds } },
          data: { messageId, channelId, serverId: result.serverId },
        });
      }
      return tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
        },
      });
    });

    const dto = serializeMessage(fullRow as MessageRow, ctx.userId);
    gatewayBroker.publish({
      type: 'MESSAGE_CREATE',
      serverId: result.serverId,
      channelId,
      data: dto,
    });

    reply.status(201).send(ok(dto));
  });

  // Edit a message ---------------------------------------------------------
  app.patch('/api/messages/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateMessageRequestSchema.parse(req.body);

    const message = await prisma.message.findUnique({
      where: { id },
      select: { id: true, authorId: true, channelId: true, serverId: true, deletedAt: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound('Message not found');
    if (message.authorId !== ctx.userId) throw TavernError.forbidden('Only the author can edit a message');

    const cleanContent = sanitizeContent(body.content);
    const updated = await prisma.message.update({
      where: { id },
      data: { content: cleanContent, editedAt: new Date() },
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
      },
    });
    const dto = serializeMessage(updated as MessageRow, ctx.userId);
    gatewayBroker.publish({
      type: 'MESSAGE_UPDATE',
      serverId: message.serverId,
      channelId: message.channelId,
      data: dto,
    });
    reply.send(ok(dto));
  });

  // Delete a message -------------------------------------------------------
  app.delete('/api/messages/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: { id: true, authorId: true, channelId: true, serverId: true, deletedAt: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound('Message not found');

    if (message.authorId !== ctx.userId) {
      // Need MANAGE_MESSAGES on the channel to delete others' messages.
      const result = await getChannelPermissions(message.channelId, ctx.userId);
      if (!result) throw TavernError.notFound('Message not found');
      if (
        (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR &&
        (result.perms & Permission.MANAGE_MESSAGES) !== Permission.MANAGE_MESSAGES
      ) {
        throw TavernError.forbidden();
      }
    }

    const deletedAt = new Date();
    await prisma.message.update({
      where: { id },
      data: { deletedAt, content: '' },
    });
    if (message.authorId !== ctx.userId) {
      await writeAuditEntry({
        serverId: message.serverId,
        actorId: ctx.userId,
        action: 'message.deleted',
        targetType: 'message',
        targetId: id,
      });
    }
    gatewayBroker.publish({
      type: 'MESSAGE_DELETE',
      serverId: message.serverId,
      channelId: message.channelId,
      data: { id, channelId: message.channelId, deletedAt: deletedAt.toISOString() },
    });
    reply.send(ok({ id }));
  });
}
