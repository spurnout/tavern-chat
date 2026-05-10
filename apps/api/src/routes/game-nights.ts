import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createGameNightRequestSchema,
  gameNightRsvpRequestSchema,
  idSchema,
  Permission,
  proposeGameRequestSchema,
  TavernError,
  ulid,
  updateGameNightRequestSchema,
  voteForGameRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

interface GameNightRow {
  id: string;
  serverId: string;
  title: string;
  description: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  location: string | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  status: string;
  selectedBoardGameId: string | null;
  createdById: string;
  createdAt: Date;
}

function serialize(g: GameNightRow) {
  return {
    id: g.id,
    serverId: g.serverId,
    title: g.title,
    description: g.description,
    scheduledStart: g.scheduledStart?.toISOString() ?? null,
    scheduledEnd: g.scheduledEnd?.toISOString() ?? null,
    location: g.location,
    voiceChannelId: g.voiceChannelId,
    textChannelId: g.textChannelId,
    status: g.status as 'planning' | 'scheduled' | 'live' | 'completed' | 'cancelled',
    selectedBoardGameId: g.selectedBoardGameId,
    createdById: g.createdById,
    createdAt: g.createdAt.toISOString(),
  };
}

export async function registerGameNightRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:serverId/game-nights', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    if ((await getServerPermissions(serverId, ctx.userId)) === 0n) throw TavernError.notFound();
    const rows = await prisma.gameNight.findMany({
      where: { serverId },
      orderBy: { scheduledStart: 'desc' },
    });
    reply.send(ok(rows.map((r) => serialize(r as unknown as GameNightRow))));
  });

  app.post('/api/servers/:serverId/game-nights', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = createGameNightRequestSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.CREATE_GAME_NIGHTS);

    const id = ulid();
    const created = await prisma.$transaction(async (tx) => {
      const g = await tx.gameNight.create({
        data: {
          id,
          serverId,
          title: body.title,
          description: body.description ?? null,
          scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null,
          scheduledEnd: body.scheduledEnd ? new Date(body.scheduledEnd) : null,
          location: body.location ?? null,
          voiceChannelId: body.voiceChannelId ?? null,
          textChannelId: body.textChannelId ?? null,
          createdById: ctx.userId,
        },
      });
      if (body.candidateBoardGameIds?.length) {
        await tx.gameNightCandidate.createMany({
          data: body.candidateBoardGameIds.map((boardGameId) => ({
            gameNightId: id,
            boardGameId,
            proposedById: ctx.userId,
          })),
        });
      }
      return g;
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'game_night.created',
      targetType: 'game_night',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'GAME_NIGHT_CREATE',
      serverId,
      data: serialize(created as unknown as GameNightRow),
    });
    reply.status(201).send(ok(serialize(created as unknown as GameNightRow)));
  });

  app.patch('/api/game-nights/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateGameNightRequestSchema.parse(req.body);
    const gn = await prisma.gameNight.findUnique({ where: { id } });
    if (!gn) throw TavernError.notFound();
    if (gn.createdById !== ctx.userId) {
      await requireServerPermission(gn.serverId, ctx.userId, Permission.MANAGE_GAME_NIGHTS);
    }

    const updated = await prisma.gameNight.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.scheduledStart !== undefined
          ? { scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null }
          : {}),
        ...(body.scheduledEnd !== undefined
          ? { scheduledEnd: body.scheduledEnd ? new Date(body.scheduledEnd) : null }
          : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.voiceChannelId !== undefined ? { voiceChannelId: body.voiceChannelId } : {}),
        ...(body.textChannelId !== undefined ? { textChannelId: body.textChannelId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.selectedBoardGameId !== undefined
          ? { selectedBoardGameId: body.selectedBoardGameId }
          : {}),
      },
    });
    gatewayBroker.publish({
      type: 'GAME_NIGHT_UPDATE',
      serverId: gn.serverId,
      data: serialize(updated as unknown as GameNightRow),
    });
    reply.send(ok(serialize(updated as unknown as GameNightRow)));
  });

  // Candidates -------------------------------------------------------------
  app.get('/api/game-nights/:id/candidates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const gn = await prisma.gameNight.findUnique({ where: { id } });
    if (!gn) throw TavernError.notFound();
    if ((await getServerPermissions(gn.serverId, ctx.userId)) === 0n) throw TavernError.notFound();

    const candidates = await prisma.gameNightCandidate.findMany({
      where: { gameNightId: id },
    });
    const votes = await prisma.gameNightVote.findMany({ where: { gameNightId: id } });
    const myVotes = new Set(votes.filter((v) => v.userId === ctx.userId).map((v) => v.boardGameId));
    const voteCounts = new Map<string, number>();
    for (const v of votes) voteCounts.set(v.boardGameId, (voteCounts.get(v.boardGameId) ?? 0) + 1);

    reply.send(
      ok(
        candidates.map((c) => ({
          gameNightId: c.gameNightId,
          boardGameId: c.boardGameId,
          proposedById: c.proposedById,
          voteCount: voteCounts.get(c.boardGameId) ?? 0,
          meVoted: myVotes.has(c.boardGameId),
        })),
      ),
    );
  });

  app.post('/api/game-nights/:id/candidates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = proposeGameRequestSchema.parse(req.body);
    const gn = await prisma.gameNight.findUnique({ where: { id } });
    if (!gn) throw TavernError.notFound();
    if ((await getServerPermissions(gn.serverId, ctx.userId)) === 0n) throw TavernError.notFound();

    const game = await prisma.boardGame.findUnique({ where: { id: body.boardGameId } });
    if (!game || game.serverId !== gn.serverId) throw TavernError.validation('Unknown board game');

    await prisma.gameNightCandidate.upsert({
      where: { gameNightId_boardGameId: { gameNightId: id, boardGameId: body.boardGameId } },
      create: { gameNightId: id, boardGameId: body.boardGameId, proposedById: ctx.userId },
      update: {},
    });
    reply.send(ok({ gameNightId: id, boardGameId: body.boardGameId }));
  });

  app.post('/api/game-nights/:id/votes', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = voteForGameRequestSchema.parse(req.body);
    const gn = await prisma.gameNight.findUnique({ where: { id } });
    if (!gn) throw TavernError.notFound();
    if ((await getServerPermissions(gn.serverId, ctx.userId)) === 0n) throw TavernError.notFound();

    const candidate = await prisma.gameNightCandidate.findUnique({
      where: {
        gameNightId_boardGameId: { gameNightId: id, boardGameId: body.boardGameId },
      },
    });
    if (!candidate) throw TavernError.validation('Game is not a candidate');

    // One vote per user per game night.
    await prisma.$transaction(async (tx) => {
      await tx.gameNightVote.deleteMany({ where: { gameNightId: id, userId: ctx.userId } });
      await tx.gameNightVote.create({
        data: { gameNightId: id, boardGameId: body.boardGameId, userId: ctx.userId },
      });
    });
    reply.send(ok({ gameNightId: id, boardGameId: body.boardGameId }));
  });

  app.put('/api/game-nights/:id/rsvp', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = gameNightRsvpRequestSchema.parse(req.body);
    const gn = await prisma.gameNight.findUnique({ where: { id } });
    if (!gn) throw TavernError.notFound();
    if ((await getServerPermissions(gn.serverId, ctx.userId)) === 0n) throw TavernError.notFound();

    await prisma.gameNightRsvp.upsert({
      where: { gameNightId_userId: { gameNightId: id, userId: ctx.userId } },
      create: { gameNightId: id, userId: ctx.userId, status: body.status },
      update: { status: body.status },
    });
    reply.send(ok({ gameNightId: id, userId: ctx.userId, status: body.status }));
  });
}
