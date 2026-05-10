import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createBoardGameRequestSchema,
  filterBoardGamesQuerySchema,
  idSchema,
  Permission,
  TavernError,
  ulid,
  updateBoardGameRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';

interface BoardGameRow {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  minPlayers: number;
  maxPlayers: number;
  playTimeMinutes: number | null;
  complexity: number | null;
  ownerUserId: string | null;
  coverAttachmentId: string | null;
  tags: string[];
  createdAt: Date;
}

function serialize(b: BoardGameRow) {
  return {
    id: b.id,
    serverId: b.serverId,
    name: b.name,
    description: b.description,
    minPlayers: b.minPlayers,
    maxPlayers: b.maxPlayers,
    playTimeMinutes: b.playTimeMinutes,
    complexity: b.complexity,
    ownerUserId: b.ownerUserId,
    coverAttachmentId: b.coverAttachmentId,
    tags: b.tags,
    createdAt: b.createdAt.toISOString(),
  };
}

export async function registerBoardGameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:serverId/board-games', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    if ((await getServerPermissions(serverId, ctx.userId)) === 0n) throw TavernError.notFound();
    const q = filterBoardGamesQuerySchema.parse(req.query);

    const where: Record<string, unknown> = { serverId };
    if (q.players) {
      Object.assign(where, {
        AND: [{ minPlayers: { lte: q.players } }, { maxPlayers: { gte: q.players } }],
      });
    }
    if (q.maxPlayTimeMinutes) {
      where['playTimeMinutes'] = { lte: q.maxPlayTimeMinutes };
    }
    if (q.maxComplexity) {
      where['complexity'] = { lte: q.maxComplexity };
    }
    if (q.tag) {
      where['tags'] = { has: q.tag };
    }
    if (q.search) {
      where['name'] = { contains: q.search, mode: 'insensitive' };
    }

    const rows = await prisma.boardGame.findMany({
      where: where as never,
      orderBy: { name: 'asc' },
    });
    reply.send(ok(rows.map((r) => serialize(r as unknown as BoardGameRow))));
  });

  app.post('/api/servers/:serverId/board-games', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = createBoardGameRequestSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_BOARD_GAMES);

    if (body.minPlayers > body.maxPlayers) {
      throw TavernError.validation('minPlayers cannot exceed maxPlayers');
    }

    const created = await prisma.boardGame.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        description: body.description ?? null,
        minPlayers: body.minPlayers,
        maxPlayers: body.maxPlayers,
        playTimeMinutes: body.playTimeMinutes ?? null,
        complexity: body.complexity ?? null,
        ownerUserId: body.ownerUserId ?? ctx.userId,
        coverAttachmentId: body.coverAttachmentId ?? null,
        tags: body.tags ?? [],
      },
    });
    reply.status(201).send(ok(serialize(created as unknown as BoardGameRow)));
  });

  app.patch('/api/board-games/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateBoardGameRequestSchema.parse(req.body);
    const game = await prisma.boardGame.findUnique({ where: { id } });
    if (!game) throw TavernError.notFound();
    await requireServerPermission(game.serverId, ctx.userId, Permission.MANAGE_BOARD_GAMES);
    const updated = await prisma.boardGame.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.minPlayers !== undefined ? { minPlayers: body.minPlayers } : {}),
        ...(body.maxPlayers !== undefined ? { maxPlayers: body.maxPlayers } : {}),
        ...(body.playTimeMinutes !== undefined ? { playTimeMinutes: body.playTimeMinutes } : {}),
        ...(body.complexity !== undefined ? { complexity: body.complexity } : {}),
        ...(body.coverAttachmentId !== undefined
          ? { coverAttachmentId: body.coverAttachmentId }
          : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      },
    });
    reply.send(ok(serialize(updated as unknown as BoardGameRow)));
  });

  app.delete('/api/board-games/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const game = await prisma.boardGame.findUnique({ where: { id } });
    if (!game) throw TavernError.notFound();
    await requireServerPermission(game.serverId, ctx.userId, Permission.MANAGE_BOARD_GAMES);
    await prisma.boardGame.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
