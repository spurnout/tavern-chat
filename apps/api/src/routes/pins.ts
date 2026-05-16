import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const pinNoteSchema = z.object({ note: z.string().max(280).optional() });

export async function registerPinRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/:id/pins', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);

    const pins = await prisma.pinnedMessage.findMany({
      where: { channelId },
      orderBy: { pinnedAt: 'desc' },
      include: {
        message: {
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
          },
        },
      },
    });

    reply.send(
      ok(
        pins.map((p) => ({
          channelId: p.channelId,
          messageId: p.messageId,
          pinnedBy: p.pinnedBy,
          pinnedAt: p.pinnedAt.toISOString(),
          note: p.note,
          message: serializeMessage(p.message as MessageRow, ctx.userId),
        })),
      ),
    );
  });

  app.post('/api/channels/:id/pins/:messageId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId, messageId } = z
      .object({ id: idSchema, messageId: idSchema })
      .parse(req.params);
    const body = pinNoteSchema.parse(req.body ?? {});

    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_MESSAGES);

    const target = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, deletedAt: true },
    });
    if (!target || target.channelId !== channelId || target.deletedAt) {
      throw TavernError.validation('Pin target invalid');
    }

    const pin = await prisma.pinnedMessage.upsert({
      where: { messageId },
      create: {
        messageId,
        channelId,
        pinnedBy: ctx.userId,
        note: body.note ?? null,
      },
      update: {
        // A second pin of the same message updates the note + actor stamp.
        pinnedBy: ctx.userId,
        note: body.note ?? null,
        pinnedAt: new Date(),
      },
    });

    gatewayBroker.publish({
      type: 'MESSAGE_PIN',
      channelId,
      data: {
        channelId,
        messageId,
        pinnedBy: pin.pinnedBy,
        pinnedAt: pin.pinnedAt.toISOString(),
        note: pin.note,
      },
    });

    reply.status(201).send(
      ok({
        channelId,
        messageId,
        pinnedBy: pin.pinnedBy,
        pinnedAt: pin.pinnedAt.toISOString(),
        note: pin.note,
      }),
    );
  });

  app.delete('/api/channels/:id/pins/:messageId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId, messageId } = z
      .object({ id: idSchema, messageId: idSchema })
      .parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_MESSAGES);

    const existing = await prisma.pinnedMessage.findUnique({ where: { messageId } });
    if (!existing || existing.channelId !== channelId) {
      throw TavernError.notFound('Pin not found');
    }
    await prisma.pinnedMessage.delete({ where: { messageId } });

    gatewayBroker.publish({
      type: 'MESSAGE_UNPIN',
      channelId,
      data: { channelId, messageId },
    });

    reply.send(ok({ channelId, messageId }));
  });
}
