import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  DiceParseError,
  evaluateDiceNotation,
  idSchema,
  Permission,
  TavernError,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';

const createTableSchema = z.object({
  name: z.string().min(1).max(120),
  diceNotation: z.string().min(1).max(40).default('1d100'),
  campaignId: idSchema.nullable().optional(),
  rows: z
    .array(
      z.object({
        rangeMin: z.number().int().min(0).max(9999),
        rangeMax: z.number().int().min(0).max(9999),
        label: z.string().min(1).max(120),
        weight: z.number().int().min(1).max(1000).default(1),
        resultText: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(500),
});

const rollBodySchema = z.object({
  /** When set, the result is posted to this channel as a dice_roll message. */
  channelId: idSchema.optional(),
});

export async function registerRandomTableRoutes(app: FastifyInstance): Promise<void> {
  // List server tables (campaign-scoped or not).
  app.get('/api/servers/:id/tables', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const tables = await prisma.randomTable.findMany({
      where: { serverId },
      orderBy: { name: 'asc' },
      include: { rows: { orderBy: { rangeMin: 'asc' } } },
    });
    reply.send(
      ok(
        tables.map((t) => ({
          id: t.id,
          serverId: t.serverId,
          campaignId: t.campaignId,
          name: t.name,
          diceNotation: t.diceNotation,
          ownerId: t.ownerId,
          createdAt: t.createdAt.toISOString(),
          rows: t.rows.map((r) => ({
            id: r.id,
            tableId: r.tableId,
            rangeMin: r.rangeMin,
            rangeMax: r.rangeMax,
            label: r.label,
            weight: r.weight,
            resultText: r.resultText,
          })),
        })),
      ),
    );
  });

  app.post('/api/servers/:id/tables', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createTableSchema.parse(req.body);
    // CREATE_CAMPAIGNS implies GM-level intent; reuse for tables.
    await requireServerPermission(serverId, ctx.userId, Permission.CREATE_CAMPAIGNS);

    // Validate dice notation up-front so a bad string doesn't lurk until
    // the first roll.
    try {
      evaluateDiceNotation(body.diceNotation);
    } catch (err) {
      if (err instanceof DiceParseError) {
        throw new TavernError('INVALID_DICE_NOTATION', err.message, 400);
      }
      throw err;
    }

    const tableId = ulid();
    const table = await prisma.$transaction(async (tx) => {
      await tx.randomTable.create({
        data: {
          id: tableId,
          serverId,
          campaignId: body.campaignId ?? null,
          name: body.name,
          diceNotation: body.diceNotation,
          ownerId: ctx.userId,
        },
      });
      if (body.rows.length > 0) {
        await tx.randomTableRow.createMany({
          data: body.rows.map((r) => ({
            id: ulid(),
            tableId,
            rangeMin: r.rangeMin,
            rangeMax: r.rangeMax,
            label: r.label,
            weight: r.weight,
            resultText: r.resultText,
          })),
        });
      }
      return tx.randomTable.findUniqueOrThrow({
        where: { id: tableId },
        include: { rows: true },
      });
    });
    reply.status(201).send(
      ok({
        id: table.id,
        serverId: table.serverId,
        campaignId: table.campaignId,
        name: table.name,
        diceNotation: table.diceNotation,
        ownerId: table.ownerId,
        createdAt: table.createdAt.toISOString(),
        rows: table.rows.map((r) => ({
          id: r.id,
          tableId: r.tableId,
          rangeMin: r.rangeMin,
          rangeMax: r.rangeMax,
          label: r.label,
          weight: r.weight,
          resultText: r.resultText,
        })),
      }),
    );
  });

  app.delete('/api/tables/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const table = await prisma.randomTable.findUnique({ where: { id } });
    if (!table) throw TavernError.notFound('Table not found');
    if (table.ownerId !== ctx.userId) {
      await requireServerPermission(table.serverId, ctx.userId, Permission.MANAGE_CAMPAIGNS);
    }
    await prisma.randomTable.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  // Roll the table. Returns { roll, matchedRow }. When channelId is set,
  // also posts a dice-roll message into that channel.
  app.post('/api/tables/:id/roll', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = rollBodySchema.parse(req.body ?? {});
    const table = await prisma.randomTable.findUnique({
      where: { id },
      include: { rows: true },
    });
    if (!table) throw TavernError.notFound('Table not found');

    let rollResult;
    try {
      rollResult = evaluateDiceNotation(table.diceNotation);
    } catch (err) {
      if (err instanceof DiceParseError) {
        throw new TavernError('INVALID_DICE_NOTATION', err.message, 400);
      }
      throw err;
    }
    const value = rollResult.total;
    const matched =
      table.rows.find((r) => value >= r.rangeMin && value <= r.rangeMax) ?? null;

    let messageId: string | null = null;
    if (body.channelId) {
      // Posting requires send-permission in the target channel.
      const { requireChannelPermission } = await import(
        '../services/permissions-service.js'
      );
      const channelPerms = await requireChannelPermission(
        body.channelId,
        ctx.userId,
        Permission.SEND_MESSAGES,
      );
      const id = ulid();
      const row = await prisma.message.create({
        data: {
          id,
          serverId: channelPerms.serverId,
          channelId: body.channelId,
          authorId: ctx.userId,
          type: 'dice_roll',
          content: `${table.name}: ${value} → ${matched?.label ?? 'no match'}`,
        },
        include: {
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
        },
      });
      gatewayBroker.publish({
        type: 'MESSAGE_CREATE',
        serverId: channelPerms.serverId,
        channelId: body.channelId,
        data: serializeMessage(row as MessageRow, ctx.userId),
      });
      messageId = id;
    }
    reply.send(
      ok({
        tableId: table.id,
        roll: rollResult,
        matchedRow: matched
          ? {
              id: matched.id,
              label: matched.label,
              resultText: matched.resultText,
            }
          : null,
        messageId,
      }),
    );
  });
}
