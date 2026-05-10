import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createCampaignRequestSchema,
  idSchema,
  Permission,
  TavernError,
  ulid,
  updateCampaignRequestSchema,
  type Campaign,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

interface CampaignRow {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  gameSystem: string | null;
  status: string;
  gmUserId: string;
  defaultChannelId: string | null;
  rulesJson: unknown;
  safetyBoundariesJson: unknown;
  createdAt: Date;
}

function serialize(c: CampaignRow): Campaign {
  return {
    id: c.id,
    serverId: c.serverId,
    name: c.name,
    description: c.description,
    gameSystem: c.gameSystem,
    status: c.status as Campaign['status'],
    gmUserId: c.gmUserId,
    defaultChannelId: c.defaultChannelId,
    rulesJson: c.rulesJson ?? null,
    safetyBoundaries: Array.isArray(c.safetyBoundariesJson)
      ? (c.safetyBoundariesJson as Campaign['safetyBoundaries'])
      : [],
    createdAt: c.createdAt.toISOString(),
  };
}

export async function registerCampaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:serverId/campaigns', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const perms = await getServerPermissions(serverId, ctx.userId);
    if (perms === 0n) throw TavernError.notFound();
    const rows = await prisma.campaign.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(ok(rows.map((r) => serialize(r as CampaignRow))));
  });

  app.post('/api/servers/:serverId/campaigns', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = createCampaignRequestSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.CREATE_CAMPAIGNS);

    const id = ulid();
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.campaign.create({
        data: {
          id,
          serverId,
          name: body.name,
          description: body.description ?? null,
          gameSystem: body.gameSystem ?? null,
          gmUserId: ctx.userId,
          defaultChannelId: body.defaultChannelId ?? null,
          safetyBoundariesJson: body.safetyBoundaries ?? [],
        },
      });
      await tx.campaignMember.create({
        data: { campaignId: id, userId: ctx.userId, role: 'co_gm' },
      });
      return c;
    });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'campaign.created',
      targetType: 'campaign',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'CAMPAIGN_CREATE',
      serverId,
      data: serialize(created as CampaignRow),
    });
    reply.status(201).send(ok(serialize(created as CampaignRow)));
  });

  app.get('/api/campaigns/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound();
    const perms = await getServerPermissions(c.serverId, ctx.userId);
    if (perms === 0n) throw TavernError.notFound();
    reply.send(ok(serialize(c as CampaignRow)));
  });

  app.patch('/api/campaigns/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateCampaignRequestSchema.parse(req.body);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound();

    // GM, MANAGE_CAMPAIGNS, or admin.
    if (c.gmUserId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.MANAGE_CAMPAIGNS);
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.gameSystem !== undefined ? { gameSystem: body.gameSystem } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.defaultChannelId !== undefined
          ? { defaultChannelId: body.defaultChannelId }
          : {}),
        ...(body.safetyBoundaries !== undefined
          ? { safetyBoundariesJson: body.safetyBoundaries }
          : {}),
      },
    });
    await writeAuditEntry({
      serverId: c.serverId,
      actorId: ctx.userId,
      action: 'campaign.updated',
      targetType: 'campaign',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'CAMPAIGN_UPDATE',
      serverId: c.serverId,
      data: serialize(updated as CampaignRow),
    });
    reply.send(ok(serialize(updated as CampaignRow)));
  });
}
