import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';

const createBody = z.object({
  userId: idSchema,
  tier: z.enum(['notice', 'warn', 'mute', 'kick', 'ban']).default('warn'),
  reason: z.string().max(280).optional(),
});

/**
 * Wave 3 #16 — Warnings + strike escalation. Each warning increments
 * `ServerMember.strikeTier`. The next-tier severity is chosen by the
 * client/operator; this route stores the record + bumps the counter.
 */
export async function registerWarningRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/warnings', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_AUDIT_LOG);
    const rows = await prisma.warning.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, displayName: true, username: true } } },
    });
    reply.send(ok(rows));
  });

  app.post('/api/servers/:id/warnings', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createBody.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_MESSAGES);

    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: body.userId } },
    });
    if (!member) throw TavernError.notFound('Member not found');

    const warning = await prisma.$transaction(async (tx) => {
      const w = await tx.warning.create({
        data: {
          id: ulid(),
          serverId,
          userId: body.userId,
          moderatorId: ctx.userId,
          tier: body.tier,
          reason: body.reason ?? null,
        },
      });
      await tx.serverMember.update({
        where: { serverId_userId: { serverId, userId: body.userId } },
        data: { strikeTier: { increment: 1 } },
      });
      return w;
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'member.warn',
      targetType: 'user',
      targetId: body.userId,
      metadata: { tier: body.tier, reason: body.reason ?? null },
    });

    reply.status(201).send(ok(warning));
  });

  app.delete('/api/warnings/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const w = await prisma.warning.findUnique({ where: { id } });
    if (!w) throw TavernError.notFound('Warning not found');
    await requireServerPermission(w.serverId, ctx.userId, Permission.MANAGE_MESSAGES);
    await prisma.$transaction(async (tx) => {
      await tx.warning.delete({ where: { id } });
      await tx.serverMember.updateMany({
        where: { serverId: w.serverId, userId: w.userId, strikeTier: { gt: 0 } },
        data: { strikeTier: { decrement: 1 } },
      });
    });
    reply.send(ok({ id }));
  });
}
