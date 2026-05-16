import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { generateNpc, idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const createNpcSchema = z.object({
  name: z.string().min(1).max(120),
  descriptionMd: z.string().max(8000).optional(),
  portraitAttachmentId: idSchema.nullable().optional(),
  factionTag: z.string().max(40).nullable().optional(),
  locationTag: z.string().max(40).nullable().optional(),
  statBlockJson: z.unknown().optional(),
  isAlive: z.boolean().optional(),
});

const updateNpcSchema = createNpcSchema.partial();

async function loadCampaignContext(campaignId: string, userId: string): Promise<{ serverId: string; isGm: boolean }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { gmUserId: true, serverId: true },
  });
  if (!campaign) throw TavernError.notFound('Campaign not found');
  const isGm = campaign.gmUserId === userId;
  if (!isGm) {
    await requireServerPermission(campaign.serverId, userId, Permission.MANAGE_CAMPAIGNS);
  }
  return { serverId: campaign.serverId, isGm };
}

export async function registerNpcRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/npcs', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    // Campaign members can view NPCs (no stat-block visibility yet).
    const member = await prisma.campaignMember.findUnique({
      where: { campaignId_userId: { campaignId, userId: ctx.userId } },
    });
    if (!member) {
      await loadCampaignContext(campaignId, ctx.userId);
    }
    const npcs = await prisma.npc.findMany({
      where: { campaignId },
      orderBy: { name: 'asc' },
    });
    reply.send(
      ok(
        npcs.map((n) => ({
          id: n.id,
          campaignId: n.campaignId,
          name: n.name,
          descriptionMd: n.descriptionMd,
          portraitAttachmentId: n.portraitAttachmentId,
          factionTag: n.factionTag,
          locationTag: n.locationTag,
          statBlockJson: n.statBlockJson,
          isAlive: n.isAlive,
          createdBy: n.createdBy,
          createdAt: n.createdAt.toISOString(),
          updatedAt: n.updatedAt.toISOString(),
        })),
      ),
    );
  });

  app.post('/api/campaigns/:id/npcs', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    const body = createNpcSchema.parse(req.body);
    await loadCampaignContext(campaignId, ctx.userId);
    const npc = await prisma.npc.create({
      data: {
        id: ulid(),
        campaignId,
        name: body.name,
        descriptionMd: body.descriptionMd ?? null,
        portraitAttachmentId: body.portraitAttachmentId ?? null,
        factionTag: body.factionTag ?? null,
        locationTag: body.locationTag ?? null,
        statBlockJson: (body.statBlockJson ?? {}) as object,
        isAlive: body.isAlive ?? true,
        createdBy: ctx.userId,
      },
    });
    reply.status(201).send(
      ok({
        id: npc.id,
        campaignId: npc.campaignId,
        name: npc.name,
        descriptionMd: npc.descriptionMd,
        portraitAttachmentId: npc.portraitAttachmentId,
        factionTag: npc.factionTag,
        locationTag: npc.locationTag,
        statBlockJson: npc.statBlockJson,
        isAlive: npc.isAlive,
        createdBy: npc.createdBy,
        createdAt: npc.createdAt.toISOString(),
        updatedAt: npc.updatedAt.toISOString(),
      }),
    );
  });

  app.patch('/api/npcs/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateNpcSchema.parse(req.body);
    const existing = await prisma.npc.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('NPC not found');
    await loadCampaignContext(existing.campaignId, ctx.userId);
    const updated = await prisma.npc.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.descriptionMd !== undefined ? { descriptionMd: body.descriptionMd } : {}),
        ...(body.portraitAttachmentId !== undefined
          ? { portraitAttachmentId: body.portraitAttachmentId }
          : {}),
        ...(body.factionTag !== undefined ? { factionTag: body.factionTag } : {}),
        ...(body.locationTag !== undefined ? { locationTag: body.locationTag } : {}),
        ...(body.statBlockJson !== undefined ? { statBlockJson: body.statBlockJson as object } : {}),
        ...(body.isAlive !== undefined ? { isAlive: body.isAlive } : {}),
      },
    });
    reply.send(
      ok({
        id: updated.id,
        campaignId: updated.campaignId,
        name: updated.name,
        descriptionMd: updated.descriptionMd,
        portraitAttachmentId: updated.portraitAttachmentId,
        factionTag: updated.factionTag,
        locationTag: updated.locationTag,
        statBlockJson: updated.statBlockJson,
        isAlive: updated.isAlive,
        createdBy: updated.createdBy,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      }),
    );
  });

  app.delete('/api/npcs/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.npc.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('NPC not found');
    await loadCampaignContext(existing.campaignId, ctx.userId);
    await prisma.npc.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  // Wave 3 #14 — Generate an NPC and optionally persist it. The `persist`
  // flag defaults to false so GMs can spin the generator until something
  // sticks; once happy they POST it back through /campaigns/:id/npcs.
  app.post('/api/campaigns/:id/npcs/generate', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({ seed: z.number().int().optional(), persist: z.boolean().default(false) })
      .parse(req.body ?? {});
    const { isGm } = await loadCampaignContext(campaignId, ctx.userId);
    void isGm;
    const npc = generateNpc(body.seed);
    if (!body.persist) {
      reply.send(ok({ generated: npc, persisted: null }));
      return;
    }
    const descriptionMd =
      `${npc.race} ${npc.occupation}. ${npc.appearance.replace(/^./, (c) => c.toUpperCase())}.\n\n` +
      `Voice: ${npc.voice}.\nQuirk: ${npc.quirk}.\nHook: ${npc.hook}.`;
    const row = await prisma.npc.create({
      data: {
        id: ulid(),
        campaignId,
        name: npc.name,
        descriptionMd,
        portraitAttachmentId: null,
        factionTag: null,
        locationTag: null,
        statBlockJson: {} as object,
        isAlive: true,
        createdBy: ctx.userId,
      },
    });
    reply.status(201).send(ok({ generated: npc, persisted: row }));
  });
}
