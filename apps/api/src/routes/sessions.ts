import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createCampaignSessionRequestSchema,
  idSchema,
  Permission,
  rsvpRequestSchema,
  TavernError,
  ulid,
  updateCampaignSessionRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

interface SessionRow {
  id: string;
  campaignId: string;
  serverId: string;
  title: string;
  description: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  status: string;
  agenda: string | null;
  recap: string | null;
  createdAt: Date;
}

function serialize(s: SessionRow) {
  return {
    id: s.id,
    campaignId: s.campaignId,
    serverId: s.serverId,
    title: s.title,
    description: s.description,
    scheduledStart: s.scheduledStart?.toISOString() ?? null,
    scheduledEnd: s.scheduledEnd?.toISOString() ?? null,
    voiceChannelId: s.voiceChannelId,
    textChannelId: s.textChannelId,
    status: s.status as 'planned' | 'live' | 'completed' | 'cancelled',
    agenda: s.agenda,
    recap: s.recap,
    createdAt: s.createdAt.toISOString(),
  };
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/sessions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id }, select: { serverId: true } });
    if (!c) throw TavernError.notFound();
    if ((await getServerPermissions(c.serverId, ctx.userId)) === 0n) throw TavernError.notFound();
    const rows = await prisma.campaignSession.findMany({
      where: { campaignId: id },
      orderBy: { scheduledStart: 'desc' },
    });
    reply.send(ok(rows.map((r) => serialize(r as SessionRow))));
  });

  app.post('/api/sessions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createCampaignSessionRequestSchema.parse(req.body);
    const c = await prisma.campaign.findUnique({ where: { id: body.campaignId } });
    if (!c) throw TavernError.notFound();
    if (c.gmUserId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.CREATE_SESSIONS);
    }

    const id = ulid();
    const created = await prisma.campaignSession.create({
      data: {
        id,
        campaignId: c.id,
        serverId: c.serverId,
        title: body.title,
        description: body.description ?? null,
        scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null,
        scheduledEnd: body.scheduledEnd ? new Date(body.scheduledEnd) : null,
        voiceChannelId: body.voiceChannelId ?? null,
        textChannelId: body.textChannelId ?? null,
        agenda: body.agenda ?? null,
      },
    });
    await writeAuditEntry({
      serverId: c.serverId,
      actorId: ctx.userId,
      action: 'session.created',
      targetType: 'session',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'CAMPAIGN_SESSION_CREATE',
      serverId: c.serverId,
      data: serialize(created as SessionRow),
    });
    reply.status(201).send(ok(serialize(created as SessionRow)));
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateCampaignSessionRequestSchema.parse(req.body);
    const session = await prisma.campaignSession.findUnique({ where: { id } });
    if (!session) throw TavernError.notFound();
    const campaign = await prisma.campaign.findUnique({ where: { id: session.campaignId } });
    if (!campaign) throw TavernError.notFound();
    if (campaign.gmUserId !== ctx.userId) {
      await requireServerPermission(campaign.serverId, ctx.userId, Permission.MANAGE_SESSIONS);
    }

    const updated = await prisma.campaignSession.update({
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
        ...(body.voiceChannelId !== undefined ? { voiceChannelId: body.voiceChannelId } : {}),
        ...(body.textChannelId !== undefined ? { textChannelId: body.textChannelId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.agenda !== undefined ? { agenda: body.agenda } : {}),
        ...(body.recap !== undefined ? { recap: body.recap } : {}),
      },
    });
    gatewayBroker.publish({
      type: 'CAMPAIGN_SESSION_UPDATE',
      serverId: session.serverId,
      data: serialize(updated as SessionRow),
    });
    reply.send(ok(serialize(updated as SessionRow)));
  });

  app.put('/api/sessions/:id/rsvp', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = rsvpRequestSchema.parse(req.body);
    const session = await prisma.campaignSession.findUnique({ where: { id } });
    if (!session) throw TavernError.notFound();
    if ((await getServerPermissions(session.serverId, ctx.userId)) === 0n) {
      throw TavernError.notFound();
    }
    await prisma.campaignSessionRsvp.upsert({
      where: { sessionId_userId: { sessionId: id, userId: ctx.userId } },
      create: { sessionId: id, userId: ctx.userId, status: body.status },
      update: { status: body.status },
    });
    reply.send(ok({ sessionId: id, userId: ctx.userId, status: body.status }));
  });
}
