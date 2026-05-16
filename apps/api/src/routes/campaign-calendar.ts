import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const upsertCalendarSchema = z.object({
  system: z.enum(['gregorian', 'forgotten_realms', 'custom']).default('gregorian'),
  systemJson: z.unknown().optional(),
  currentDate: z.string().min(1).max(40).default('0001-01-01'),
});

const createEntrySchema = z.object({
  inWorldDate: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  body: z.string().max(8000).optional(),
  sessionId: idSchema.nullable().optional(),
});

async function loadCtx(campaignId: string, userId: string): Promise<{ isGm: boolean; serverId: string }> {
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { gmUserId: true, serverId: true },
  });
  if (!c) throw TavernError.notFound('Campaign not found');
  const isGm = c.gmUserId === userId;
  if (!isGm) {
    // Members can read the calendar/timeline; only the GM can mutate.
    const member = await prisma.campaignMember.findUnique({
      where: { campaignId_userId: { campaignId, userId } },
    });
    if (!member) {
      await requireServerPermission(c.serverId, userId, Permission.MANAGE_CAMPAIGNS);
    }
  }
  return { isGm, serverId: c.serverId };
}

export async function registerCampaignCalendarRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/calendar', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    await loadCtx(campaignId, ctx.userId);
    const cal = await prisma.inWorldCalendar.findUnique({
      where: { campaignId },
      include: { entries: { orderBy: { inWorldDate: 'asc' } } },
    });
    reply.send(ok(cal));
  });

  app.put('/api/campaigns/:id/calendar', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    const body = upsertCalendarSchema.parse(req.body);
    const { isGm } = await loadCtx(campaignId, ctx.userId);
    if (!isGm) throw TavernError.forbidden('Only the GM can change the calendar');
    const cal = await prisma.inWorldCalendar.upsert({
      where: { campaignId },
      create: {
        id: ulid(),
        campaignId,
        system: body.system,
        systemJson: (body.systemJson ?? {}) as object,
        currentDate: body.currentDate,
      },
      update: {
        system: body.system,
        systemJson: (body.systemJson ?? {}) as object,
        currentDate: body.currentDate,
      },
    });
    reply.send(ok(cal));
  });

  app.post('/api/campaigns/:id/calendar/entries', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    const body = createEntrySchema.parse(req.body);
    const { isGm } = await loadCtx(campaignId, ctx.userId);
    if (!isGm) throw TavernError.forbidden();
    const cal = await prisma.inWorldCalendar.findUnique({ where: { campaignId } });
    if (!cal) {
      throw new TavernError(
        'VALIDATION_ERROR',
        'Create the calendar before adding entries',
        400,
      );
    }
    const entry = await prisma.timelineEntry.create({
      data: {
        id: ulid(),
        calendarId: cal.id,
        inWorldDate: body.inWorldDate,
        title: body.title,
        body: body.body ?? null,
        sessionId: body.sessionId ?? null,
        createdBy: ctx.userId,
      },
    });
    reply.status(201).send(ok(entry));
  });

  app.delete('/api/calendar-entries/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const entry = await prisma.timelineEntry.findUnique({
      where: { id },
      include: { calendar: { select: { campaignId: true } } },
    });
    if (!entry) throw TavernError.notFound('Entry not found');
    const { isGm } = await loadCtx(entry.calendar.campaignId, ctx.userId);
    if (!isGm) throw TavernError.forbidden();
    await prisma.timelineEntry.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
