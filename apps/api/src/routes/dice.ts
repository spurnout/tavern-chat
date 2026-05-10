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
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

export async function registerDiceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/dice/roll', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = rollDiceRequestSchema.parse(req.body);
    const result = await requireChannelPermission(body.channelId, ctx.userId, Permission.ROLL_DICE);

    if (body.visibility !== 'public') {
      const flag = Permission.ROLL_PRIVATE_DICE;
      if (
        (result.perms & flag) !== flag &&
        (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR
      ) {
        throw TavernError.forbidden('Private dice rolls require ROLL_PRIVATE_DICE');
      }
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
          serverId: result.serverId,
          channelId: body.channelId,
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
            serverId: result.serverId,
            channelId: body.channelId,
            authorId: ctx.userId,
            type: 'dice_roll',
            content: body.label ? `${body.label}: ${rollResult.notation}` : rollResult.notation,
            diceRollId: r.id,
          },
        });
      }
      return { roll: r, message: m };
    });

    const dto = {
      id: roll.id,
      serverId: roll.serverId,
      channelId: roll.channelId,
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
      gatewayBroker.publish({
        type: 'DICE_ROLL_CREATE',
        serverId: result.serverId,
        channelId: body.channelId,
        data: dto,
      });
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
