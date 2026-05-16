import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const participantInputSchema = z.object({
  name: z.string().min(1).max(60),
  initiative: z.number().int().min(-99).max(99).default(0),
  hp: z.number().int().min(-999).max(9999).default(0),
  maxHp: z.number().int().min(0).max(9999).default(0),
  isPc: z.boolean().default(false),
  conditions: z.array(z.string().max(40)).default([]),
});

const createBodySchema = z.object({
  name: z.string().max(120).optional(),
  campaignId: idSchema.nullable().optional(),
  participants: z.array(participantInputSchema).default([]),
});

const participantPatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  initiative: z.number().int().min(-99).max(99).optional(),
  hp: z.number().int().min(-999).max(9999).optional(),
  maxHp: z.number().int().min(0).max(9999).optional(),
  isPc: z.boolean().optional(),
  conditions: z.array(z.string().max(40)).optional(),
  hidden: z.boolean().optional(),
  position: z.number().int().min(0).max(99).optional(),
});

async function loadEncounterDto(id: string): Promise<{
  id: string;
  channelId: string;
  campaignId: string | null;
  createdBy: string;
  status: string;
  currentTurnIndex: number;
  round: number;
  name: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  participants: Array<{
    id: string;
    name: string;
    initiative: number;
    hp: number;
    maxHp: number;
    conditions: string[];
    isPc: boolean;
    position: number;
    hidden: boolean;
  }>;
} | null> {
  const e = await prisma.initiativeEncounter.findUnique({
    where: { id },
    include: { participants: { orderBy: { position: 'asc' } } },
  });
  if (!e) return null;
  return {
    id: e.id,
    channelId: e.channelId,
    campaignId: e.campaignId,
    createdBy: e.createdBy,
    status: e.status,
    currentTurnIndex: e.currentTurnIndex,
    round: e.round,
    name: e.name,
    startedAt: e.startedAt?.toISOString() ?? null,
    endedAt: e.endedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    participants: e.participants.map((p) => ({
      id: p.id,
      name: p.name,
      initiative: p.initiative,
      hp: p.hp,
      maxHp: p.maxHp,
      conditions: Array.isArray(p.conditions) ? (p.conditions as string[]) : [],
      isPc: p.isPc,
      position: p.position,
      hidden: p.hidden,
    })),
  };
}

export async function registerEncounterRoutes(app: FastifyInstance): Promise<void> {
  // ---- Get active encounter in a channel --------------------------------
  app.get('/api/channels/:id/encounter', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);

    const active = await prisma.initiativeEncounter.findFirst({
      where: { channelId, status: { in: ['setup', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      reply.send(ok(null));
      return;
    }
    const dto = await loadEncounterDto(active.id);
    reply.send(ok(dto));
  });

  // ---- Create -----------------------------------------------------------
  app.post('/api/channels/:id/encounters', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = createBodySchema.parse(req.body);

    // Encounters are GM-level tooling; require MANAGE_SESSIONS (GMs have it).
    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    const id = ulid();
    const sortedInitiative = [...body.participants].sort(
      (a, b) => b.initiative - a.initiative,
    );
    await prisma.$transaction(async (tx) => {
      await tx.initiativeEncounter.create({
        data: {
          id,
          channelId,
          campaignId: body.campaignId ?? null,
          createdBy: ctx.userId,
          name: body.name ?? null,
        },
      });
      if (sortedInitiative.length > 0) {
        await tx.initiativeParticipant.createMany({
          data: sortedInitiative.map((p, i) => ({
            id: ulid(),
            encounterId: id,
            name: p.name,
            initiative: p.initiative,
            hp: p.hp,
            maxHp: p.maxHp,
            isPc: p.isPc,
            conditions: p.conditions,
            position: i,
          })),
        });
      }
    });

    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_CREATE',
        channelId,
        data: dto,
      });
    }
    reply.status(201).send(ok(dto));
  });

  // ---- Start (setup → running) -----------------------------------------
  app.post('/api/encounters/:id/start', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.initiativeEncounter.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('Encounter not found');
    await requireChannelPermission(existing.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    await prisma.initiativeEncounter.update({
      where: { id },
      data: { status: 'running', startedAt: new Date(), currentTurnIndex: 0, round: 1 },
    });
    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_UPDATE',
        channelId: existing.channelId,
        data: dto,
      });
    }
    reply.send(ok(dto));
  });

  // ---- Next turn --------------------------------------------------------
  app.post('/api/encounters/:id/next-turn', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.initiativeEncounter.findUnique({
      where: { id },
      include: { participants: { select: { id: true } } },
    });
    if (!existing) throw TavernError.notFound('Encounter not found');
    if (existing.status !== 'running') {
      throw TavernError.validation('Encounter is not running');
    }
    await requireChannelPermission(existing.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    const count = existing.participants.length;
    if (count === 0) {
      reply.send(ok(await loadEncounterDto(id)));
      return;
    }
    const nextIndex = (existing.currentTurnIndex + 1) % count;
    const nextRound = nextIndex === 0 ? existing.round + 1 : existing.round;

    await prisma.initiativeEncounter.update({
      where: { id },
      data: { currentTurnIndex: nextIndex, round: nextRound },
    });
    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_UPDATE',
        channelId: existing.channelId,
        data: dto,
      });
    }
    reply.send(ok(dto));
  });

  // ---- Patch a participant ---------------------------------------------
  app.patch('/api/encounters/:id/participants/:pid', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, pid } = z.object({ id: idSchema, pid: idSchema }).parse(req.params);
    const body = participantPatchSchema.parse(req.body);

    const existing = await prisma.initiativeEncounter.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('Encounter not found');
    await requireChannelPermission(existing.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    await prisma.initiativeParticipant.update({
      where: { id: pid },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.initiative !== undefined ? { initiative: body.initiative } : {}),
        ...(body.hp !== undefined ? { hp: body.hp } : {}),
        ...(body.maxHp !== undefined ? { maxHp: body.maxHp } : {}),
        ...(body.isPc !== undefined ? { isPc: body.isPc } : {}),
        ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
        ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
      },
    });
    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_UPDATE',
        channelId: existing.channelId,
        data: dto,
      });
    }
    reply.send(ok(dto));
  });

  // ---- Add participant --------------------------------------------------
  app.post('/api/encounters/:id/participants', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = participantInputSchema.parse(req.body);
    const existing = await prisma.initiativeEncounter.findUnique({
      where: { id },
      include: { participants: { select: { position: true } } },
    });
    if (!existing) throw TavernError.notFound('Encounter not found');
    await requireChannelPermission(existing.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    const nextPosition =
      existing.participants.reduce((max, p) => Math.max(max, p.position), -1) + 1;
    await prisma.initiativeParticipant.create({
      data: {
        id: ulid(),
        encounterId: id,
        name: body.name,
        initiative: body.initiative,
        hp: body.hp,
        maxHp: body.maxHp,
        isPc: body.isPc,
        conditions: body.conditions,
        position: nextPosition,
      },
    });
    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_UPDATE',
        channelId: existing.channelId,
        data: dto,
      });
    }
    reply.status(201).send(ok(dto));
  });

  // ---- Remove participant ----------------------------------------------
  app.delete('/api/encounters/:id/participants/:pid', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, pid } = z.object({ id: idSchema, pid: idSchema }).parse(req.params);
    const existing = await prisma.initiativeEncounter.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('Encounter not found');
    await requireChannelPermission(existing.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    await prisma.initiativeParticipant.delete({ where: { id: pid } });
    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_UPDATE',
        channelId: existing.channelId,
        data: dto,
      });
    }
    reply.send(ok(dto));
  });

  // ---- End --------------------------------------------------------------
  app.post('/api/encounters/:id/end', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.initiativeEncounter.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('Encounter not found');
    await requireChannelPermission(existing.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    await prisma.initiativeEncounter.update({
      where: { id },
      data: { status: 'ended', endedAt: new Date() },
    });
    const dto = await loadEncounterDto(id);
    if (dto) {
      gatewayBroker.publish({
        type: 'ENCOUNTER_END',
        channelId: existing.channelId,
        data: dto,
      });
    }
    reply.send(ok(dto));
  });
}
