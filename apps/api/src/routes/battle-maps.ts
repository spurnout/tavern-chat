import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const createMapSchema = z.object({
  name: z.string().min(1).max(120),
  width: z.number().int().min(1).max(200).default(20),
  height: z.number().int().min(1).max(200).default(20),
  backgroundAttachmentId: idSchema.nullable().optional(),
});

const createSceneSchema = z.object({
  name: z.string().min(1).max(120),
});

const tokenSchema = z.object({
  label: z.string().min(1).max(120),
  color: z.string().max(7).nullable().optional(),
  characterRef: idSchema.nullable().optional(),
  x: z.number().int().min(0).max(500).default(0),
  y: z.number().int().min(0).max(500).default(0),
  w: z.number().int().min(1).max(20).default(1),
  h: z.number().int().min(1).max(20).default(1),
  hp: z.number().int().min(-999).max(9999).nullable().optional(),
  maxHp: z.number().int().min(0).max(9999).nullable().optional(),
  isPc: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

const tokenPatchSchema = tokenSchema.partial();

async function loadCampaignContext(campaignId: string, userId: string): Promise<{ serverId: string; isGm: boolean }> {
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { gmUserId: true, serverId: true },
  });
  if (!c) throw TavernError.notFound('Campaign not found');
  const isGm = c.gmUserId === userId;
  if (!isGm) {
    await requireServerPermission(c.serverId, userId, Permission.MANAGE_CAMPAIGNS);
  }
  return { serverId: c.serverId, isGm };
}

export async function registerBattleMapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/maps', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    await loadCampaignContext(campaignId, ctx.userId);
    const maps = await prisma.battleMap.findMany({
      where: { campaignId },
      orderBy: { updatedAt: 'desc' },
      include: { scenes: { include: { tokens: true } } },
    });
    reply.send(ok(maps));
  });

  app.post('/api/campaigns/:id/maps', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    const body = createMapSchema.parse(req.body);
    await loadCampaignContext(campaignId, ctx.userId);
    const id = ulid();
    const map = await prisma.battleMap.create({
      data: {
        id,
        campaignId,
        name: body.name,
        width: body.width,
        height: body.height,
        backgroundAttachmentId: body.backgroundAttachmentId ?? null,
        createdBy: ctx.userId,
      },
    });
    reply.status(201).send(ok(map));
  });

  app.delete('/api/maps/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const map = await prisma.battleMap.findUnique({ where: { id } });
    if (!map) throw TavernError.notFound('Map not found');
    await loadCampaignContext(map.campaignId, ctx.userId);
    await prisma.battleMap.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  app.post('/api/maps/:id/scenes', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = createSceneSchema.parse(req.body);
    const map = await prisma.battleMap.findUnique({ where: { id } });
    if (!map) throw TavernError.notFound('Map not found');
    await loadCampaignContext(map.campaignId, ctx.userId);
    const scene = await prisma.battleScene.create({
      data: { id: ulid(), mapId: id, name: body.name },
    });
    reply.status(201).send(ok(scene));
  });

  app.post('/api/scenes/:id/activate', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const scene = await prisma.battleScene.findUnique({
      where: { id },
      include: { map: { select: { id: true, campaignId: true } } },
    });
    if (!scene) throw TavernError.notFound('Scene not found');
    await loadCampaignContext(scene.map.campaignId, ctx.userId);
    await prisma.$transaction([
      prisma.battleScene.updateMany({
        where: { mapId: scene.map.id },
        data: { isActive: false },
      }),
      prisma.battleScene.update({ where: { id }, data: { isActive: true } }),
    ]);
    reply.send(ok({ id }));
  });

  app.post('/api/scenes/:id/tokens', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: sceneId } = z.object({ id: idSchema }).parse(req.params);
    const body = tokenSchema.parse(req.body);
    const scene = await prisma.battleScene.findUnique({
      where: { id: sceneId },
      include: { map: { select: { campaignId: true } } },
    });
    if (!scene) throw TavernError.notFound('Scene not found');
    await loadCampaignContext(scene.map.campaignId, ctx.userId);
    const token = await prisma.battleToken.create({
      data: {
        id: ulid(),
        sceneId,
        label: body.label,
        color: body.color ?? null,
        characterRef: body.characterRef ?? null,
        x: body.x,
        y: body.y,
        w: body.w,
        h: body.h,
        hp: body.hp ?? null,
        maxHp: body.maxHp ?? null,
        isPc: body.isPc,
        hidden: body.hidden,
      },
    });
    gatewayBroker.publish({
      type: 'CHARACTER_UPDATE',
      data: { kind: 'battle-token', sceneId, token },
    });
    reply.status(201).send(ok(token));
  });

  app.patch('/api/tokens/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = tokenPatchSchema.parse(req.body);
    const token = await prisma.battleToken.findUnique({
      where: { id },
      include: { scene: { include: { map: { select: { campaignId: true } } } } },
    });
    if (!token) throw TavernError.notFound('Token not found');
    await loadCampaignContext(token.scene.map.campaignId, ctx.userId);
    const updated = await prisma.battleToken.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.characterRef !== undefined ? { characterRef: body.characterRef } : {}),
        ...(body.x !== undefined ? { x: body.x } : {}),
        ...(body.y !== undefined ? { y: body.y } : {}),
        ...(body.w !== undefined ? { w: body.w } : {}),
        ...(body.h !== undefined ? { h: body.h } : {}),
        ...(body.hp !== undefined ? { hp: body.hp } : {}),
        ...(body.maxHp !== undefined ? { maxHp: body.maxHp } : {}),
        ...(body.isPc !== undefined ? { isPc: body.isPc } : {}),
        ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
      },
    });
    gatewayBroker.publish({
      type: 'CHARACTER_UPDATE',
      data: { kind: 'battle-token', sceneId: token.sceneId, token: updated },
    });
    reply.send(ok(updated));
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const token = await prisma.battleToken.findUnique({
      where: { id },
      include: { scene: { include: { map: { select: { campaignId: true } } } } },
    });
    if (!token) throw TavernError.notFound('Token not found');
    await loadCampaignContext(token.scene.map.campaignId, ctx.userId);
    await prisma.battleToken.delete({ where: { id } });
    gatewayBroker.publish({
      type: 'CHARACTER_UPDATE',
      data: { kind: 'battle-token-delete', sceneId: token.sceneId, tokenId: id },
    });
    reply.send(ok({ id }));
  });
}
