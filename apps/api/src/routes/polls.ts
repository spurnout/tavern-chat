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
  question: z.string().min(1).max(280),
  options: z.array(z.string().min(1).max(120)).min(2).max(10),
  multiChoice: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  /** ISO-8601 string or null for an open-ended poll. */
  closesAt: z.string().datetime().nullable().default(null),
});

const voteBodySchema = z.object({
  optionId: idSchema,
});

function sanitize(s: string): string {
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} });
}

interface PollDto {
  id: string;
  messageId: string;
  question: string;
  multiChoice: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  options: Array<{ id: string; label: string; position: number; voteCount: number }>;
  myVotes: string[];
}

async function loadPollDto(pollId: string, viewerId: string): Promise<PollDto | null> {
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: {
      options: { orderBy: { position: 'asc' } },
      votes: { select: { optionId: true, userId: true } },
    },
  });
  if (!poll) return null;
  const counts = new Map<string, number>();
  const mine: string[] = [];
  for (const v of poll.votes) {
    counts.set(v.optionId, (counts.get(v.optionId) ?? 0) + 1);
    if (v.userId === viewerId) mine.push(v.optionId);
  }
  return {
    id: poll.id,
    messageId: poll.messageId,
    question: poll.question,
    multiChoice: poll.multiChoice,
    anonymous: poll.anonymous,
    closesAt: poll.closesAt?.toISOString() ?? null,
    closedAt: poll.closedAt?.toISOString() ?? null,
    createdBy: poll.createdBy,
    createdAt: poll.createdAt.toISOString(),
    options: poll.options.map((o) => ({
      id: o.id,
      label: o.label,
      position: o.position,
      voteCount: counts.get(o.id) ?? 0,
    })),
    myVotes: mine,
  };
}

export async function registerPollRoutes(app: FastifyInstance): Promise<void> {
  // ---- Create -----------------------------------------------------------
  app.post('/api/channels/:id/polls', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = createBodySchema.parse(req.body);

    const result = await requireChannelPermission(channelId, ctx.userId, Permission.SEND_MESSAGES);

    const pollId = ulid();
    const messageId = ulid();
    const cleanQuestion = sanitize(body.question);

    const row = await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: messageId,
          serverId: result.serverId,
          channelId,
          authorId: ctx.userId,
          type: 'system',
          content: `Poll: ${cleanQuestion}`,
        },
      });
      await tx.poll.create({
        data: {
          id: pollId,
          messageId,
          question: cleanQuestion,
          multiChoice: body.multiChoice,
          anonymous: body.anonymous,
          closesAt: body.closesAt ? new Date(body.closesAt) : null,
          createdBy: ctx.userId,
          options: {
            create: body.options.map((label, i) => ({
              id: ulid(),
              label: sanitize(label),
              position: i,
            })),
          },
        },
      });
      return tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
          diceRoll: { select: { resultJson: true, label: true } },
          poll: { select: { id: true } },
        },
      });
    });

    const messageDto = serializeMessage(row as MessageRow, ctx.userId);
    const pollDto = await loadPollDto(pollId, ctx.userId);
    gatewayBroker.publish({
      type: 'MESSAGE_CREATE',
      serverId: result.serverId,
      channelId,
      data: messageDto,
    });
    if (pollDto) {
      gatewayBroker.publish({
        type: 'POLL_UPDATE',
        serverId: result.serverId,
        channelId,
        data: pollDto,
      });
    }
    reply.status(201).send(ok({ message: messageDto, poll: pollDto }));
  });

  // ---- Get a poll's current state ---------------------------------------
  app.get('/api/polls/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const dto = await loadPollDto(id, ctx.userId);
    if (!dto) throw TavernError.notFound('Poll not found');
    reply.send(ok(dto));
  });

  // ---- Vote -------------------------------------------------------------
  app.post('/api/polls/:id/vote', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = voteBodySchema.parse(req.body);

    const poll = await prisma.poll.findUnique({
      where: { id },
      include: { options: { select: { id: true } }, message: { select: { channelId: true } } },
    });
    if (!poll || !poll.message?.channelId) throw TavernError.notFound('Poll not found');
    if (poll.closedAt) throw TavernError.validation('Poll is closed');
    if (poll.closesAt && poll.closesAt <= new Date())
      throw TavernError.validation('Poll has closed');

    const optionMatch = poll.options.find((o) => o.id === body.optionId);
    if (!optionMatch) throw TavernError.validation('Unknown option');

    await requireChannelPermission(poll.message.channelId, ctx.userId, Permission.VIEW_CHANNEL);

    await prisma.$transaction(async (tx) => {
      if (!poll.multiChoice) {
        await tx.pollVote.deleteMany({ where: { pollId: id, userId: ctx.userId } });
      }
      await tx.pollVote.upsert({
        where: {
          pollId_optionId_userId: {
            pollId: id,
            optionId: body.optionId,
            userId: ctx.userId,
          },
        },
        create: { pollId: id, optionId: body.optionId, userId: ctx.userId },
        update: {},
      });
    });

    const updated = await loadPollDto(id, ctx.userId);
    if (updated) {
      gatewayBroker.publish({
        type: 'POLL_UPDATE',
        channelId: poll.message.channelId,
        data: updated,
      });
    }
    reply.send(ok(updated));
  });

  // ---- Unvote -----------------------------------------------------------
  app.delete('/api/polls/:id/vote/:optionId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, optionId } = z
      .object({ id: idSchema, optionId: idSchema })
      .parse(req.params);
    const poll = await prisma.poll.findUnique({
      where: { id },
      include: { message: { select: { channelId: true } } },
    });
    if (!poll || !poll.message?.channelId) throw TavernError.notFound('Poll not found');

    await prisma.pollVote.deleteMany({
      where: { pollId: id, optionId, userId: ctx.userId },
    });
    const updated = await loadPollDto(id, ctx.userId);
    if (updated) {
      gatewayBroker.publish({
        type: 'POLL_UPDATE',
        channelId: poll.message.channelId,
        data: updated,
      });
    }
    reply.send(ok(updated));
  });

  // ---- Close (creator or MANAGE_MESSAGES) -------------------------------
  app.post('/api/polls/:id/close', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);

    const poll = await prisma.poll.findUnique({
      where: { id },
      include: { message: { select: { channelId: true } } },
    });
    if (!poll || !poll.message?.channelId) throw TavernError.notFound('Poll not found');

    if (poll.createdBy !== ctx.userId) {
      await requireChannelPermission(
        poll.message.channelId,
        ctx.userId,
        Permission.MANAGE_MESSAGES,
      );
    } else {
      await requireChannelPermission(
        poll.message.channelId,
        ctx.userId,
        Permission.VIEW_CHANNEL,
      );
    }

    await prisma.poll.update({
      where: { id },
      data: { closedAt: new Date() },
    });
    const updated = await loadPollDto(id, ctx.userId);
    if (updated) {
      gatewayBroker.publish({
        type: 'POLL_CLOSE',
        channelId: poll.message.channelId,
        data: updated,
      });
    }
    reply.send(ok(updated));
  });
}
