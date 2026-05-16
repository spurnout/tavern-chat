import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  requireChannelPermission,
  requireServerPermission,
} from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const participantInput = z.object({
  name: z.string().min(1).max(60),
  initiative: z.number().int().min(-99).max(99).default(0),
  hp: z.number().int().min(-999).max(9999).default(0),
  maxHp: z.number().int().min(0).max(9999).default(0),
  isPc: z.boolean().default(false),
  conditions: z.array(z.string().max(40)).default([]),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  participants: z.array(participantInput).min(1),
  notes: z.string().max(4000).optional(),
});

const instantiateSchema = z.object({
  channelId: idSchema,
  encounterName: z.string().max(120).optional(),
});

export async function registerEncounterTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/encounter-templates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const rows = await prisma.encounterTemplate.findMany({
      where: { serverId },
      orderBy: { updatedAt: 'desc' },
    });
    reply.send(ok(rows));
  });

  app.post('/api/servers/:id/encounter-templates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createTemplateSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SESSIONS);
    const tpl = await prisma.encounterTemplate.create({
      data: {
        id: ulid(),
        serverId,
        ownerId: ctx.userId,
        name: body.name,
        participantsJson: body.participants as object,
        notes: body.notes ?? null,
      },
    });
    reply.status(201).send(ok(tpl));
  });

  app.delete('/api/encounter-templates/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const tpl = await prisma.encounterTemplate.findUnique({ where: { id } });
    if (!tpl) throw TavernError.notFound('Template not found');
    await requireServerPermission(tpl.serverId, ctx.userId, Permission.MANAGE_SESSIONS);
    await prisma.encounterTemplate.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  app.post('/api/encounter-templates/:id/instantiate', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = instantiateSchema.parse(req.body);
    const tpl = await prisma.encounterTemplate.findUnique({ where: { id } });
    if (!tpl) throw TavernError.notFound('Template not found');
    await requireServerPermission(tpl.serverId, ctx.userId, Permission.MANAGE_SESSIONS);
    await requireChannelPermission(body.channelId, ctx.userId, Permission.MANAGE_SESSIONS);

    const participants = Array.isArray(tpl.participantsJson) ? tpl.participantsJson : [];
    const encounterId = ulid();
    await prisma.$transaction(async (tx) => {
      await tx.initiativeEncounter.create({
        data: {
          id: encounterId,
          channelId: body.channelId,
          campaignId: null,
          createdBy: ctx.userId,
          name: body.encounterName ?? tpl.name,
        },
      });
      const sorted = [...participants].sort(
        (a, b) =>
          ((b as { initiative?: number }).initiative ?? 0) -
          ((a as { initiative?: number }).initiative ?? 0),
      );
      if (sorted.length > 0) {
        await tx.initiativeParticipant.createMany({
          data: sorted.map((p, i) => {
            const part = p as {
              name: string;
              initiative?: number;
              hp?: number;
              maxHp?: number;
              isPc?: boolean;
              conditions?: string[];
            };
            return {
              id: ulid(),
              encounterId,
              name: part.name,
              initiative: part.initiative ?? 0,
              hp: part.hp ?? 0,
              maxHp: part.maxHp ?? 0,
              isPc: part.isPc ?? false,
              conditions: (part.conditions ?? []) as object,
              position: i,
            };
          }),
        });
      }
    });
    gatewayBroker.publish({
      type: 'ENCOUNTER_CREATE',
      channelId: body.channelId,
      data: { id: encounterId, fromTemplateId: tpl.id },
    });
    reply.status(201).send(ok({ id: encounterId }));
  });
}
