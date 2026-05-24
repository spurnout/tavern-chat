import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  DiceParseError,
  evaluateDiceNotation,
  idSchema,
  Permission,
  rollDiceRequestSchema,
  TavernError,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { requireDmChannelMembership } from '../services/dm-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

export async function registerDiceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/dice/roll', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = rollDiceRequestSchema.parse(req.body);

    // Resolve channel context — server channel or DM — and gate accordingly.
    // For server channels we still enforce ROLL_DICE / ROLL_PRIVATE_DICE.
    // DM membership is binary (you're in or you're not); private/GM-only
    // rolls in DMs are allowed unconditionally because there's no GM role.
    let serverId: string | null = null;
    let channelId: string | null = null;
    let dmChannelId: string | null = null;
    if (body.dmChannelId) {
      await requireDmChannelMembership(body.dmChannelId, ctx.userId);
      dmChannelId = body.dmChannelId;
    } else if (body.channelId) {
      const result = await requireChannelPermission(
        body.channelId,
        ctx.userId,
        Permission.ROLL_DICE,
      );
      if (body.visibility !== 'public') {
        const flag = Permission.ROLL_PRIVATE_DICE;
        if (
          (result.perms & flag) !== flag &&
          (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR
        ) {
          throw TavernError.forbidden('Private dice rolls require ROLL_PRIVATE_DICE');
        }
      }
      serverId = result.serverId;
      channelId = body.channelId;
    } else {
      // The schema's .refine() already enforces this, but the runtime guard
      // is here so the TypeScript narrowing reads cleanly.
      throw TavernError.validation('channelId or dmChannelId is required');
    }

    let rollResult;
    try {
      rollResult = evaluateDiceNotation(body.notation);
    } catch (err) {
      if (err instanceof DiceParseError) {
        throw new TavernError('INVALID_DICE_NOTATION', err.message, 400);
      }
      throw err;
    }

    const id = ulid();
    const messageId = body.visibility === 'public' ? ulid() : null;

    const { roll, message } = await prisma.$transaction(async (tx) => {
      const r = await tx.diceRoll.create({
        data: {
          id,
          serverId,
          channelId,
          dmChannelId,
          userId: ctx.userId,
          notation: rollResult.notation,
          label: body.label ?? null,
          resultJson: rollResult,
          total: rollResult.total,
          visibility: body.visibility,
        },
      });

      let m = null;
      if (messageId && body.visibility === 'public') {
        m = await tx.message.create({
          data: {
            id: messageId,
            serverId,
            channelId,
            dmChannelId,
            authorId: ctx.userId,
            type: 'dice_roll',
            content: body.label ? `${body.label}: ${rollResult.notation}` : rollResult.notation,
            diceRollId: r.id,
          },
        });
        if (dmChannelId) {
          await tx.dmChannel.update({
            where: { id: dmChannelId },
            data: { lastMessageAt: new Date() },
          });
        }
      }
      return { roll: r, message: m };
    });

    const dto = {
      id: roll.id,
      serverId: roll.serverId,
      channelId: roll.channelId,
      dmChannelId: roll.dmChannelId,
      messageId: message?.id ?? null,
      userId: roll.userId,
      notation: roll.notation,
      label: roll.label,
      result: rollResult,
      total: roll.total,
      visibility: roll.visibility as 'public' | 'gm_only' | 'private',
      createdAt: roll.createdAt.toISOString(),
    };

    if (body.visibility === 'public') {
      if (dmChannelId && message) {
        // DM rolls fan out via DM_MESSAGE_CREATE; fetch the message with
        // its author + relations so the broadcast carries a normal Message
        // dto the client can render through its existing pipeline.
        const fullMsg = await prisma.message.findUniqueOrThrow({
          where: { id: message.id },
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
            diceRoll: { select: { resultJson: true, label: true } },
          },
        });
        gatewayBroker.publish({
          type: 'DM_MESSAGE_CREATE',
          dmChannelId,
          data: serializeMessage(fullMsg as MessageRow, ctx.userId),
        });
      } else {
        gatewayBroker.publish({
          type: 'DICE_ROLL_CREATE',
          serverId: serverId ?? undefined,
          channelId: channelId ?? undefined,
          data: dto,
        });
      }
    }

    reply.status(201).send(ok(dto));
  });

  app.get('/api/channels/:id/dice', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const result = await requireChannelPermission(id, ctx.userId, Permission.READ_MESSAGE_HISTORY);
    const rolls = await prisma.diceRoll.findMany({
      where: {
        channelId: id,
        OR: [
          { visibility: 'public' },
          { visibility: 'private', userId: ctx.userId },
          ...((result.perms & Permission.VIEW_GM_NOTES) === Permission.VIEW_GM_NOTES
            ? [{ visibility: 'gm_only' as const }]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    reply.send(ok(rolls));
  });
}
