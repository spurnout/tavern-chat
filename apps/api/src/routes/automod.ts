import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const createRuleSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['regex', 'wordlist', 'link_rate', 'message_rate']),
  pattern: z.string().min(1).max(2000),
  action: z.enum(['log_only', 'delete', 'hold', 'warn', 'timeout']).default('log_only'),
  enabled: z.boolean().default(true),
  reason: z.string().max(280).optional(),
});

const updateRuleSchema = createRuleSchema.partial();

/**
 * Wave 3 #15 — auto-moderation rules. Rules are evaluated in `position`
 * order on message-create (see automod-service); first match wins.
 */
export async function registerAutomodRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/automod', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const rows = await prisma.automodRule.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });
    reply.send(ok(rows));
  });

  app.post('/api/servers/:id/automod', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createRuleSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const maxPos = await prisma.automodRule.aggregate({
      where: { serverId },
      _max: { position: true },
    });
    const rule = await prisma.automodRule.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        kind: body.kind,
        pattern: body.pattern,
        action: body.action,
        enabled: body.enabled,
        reason: body.reason ?? null,
        createdBy: ctx.userId,
        position: (maxPos._max.position ?? -1) + 1,
      },
    });
    reply.status(201).send(ok(rule));
  });

  app.patch('/api/automod/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateRuleSchema.parse(req.body);
    const rule = await prisma.automodRule.findUnique({ where: { id } });
    if (!rule) throw TavernError.notFound('Rule not found');
    await requireServerPermission(rule.serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const updated = await prisma.automodRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.pattern !== undefined ? { pattern: body.pattern } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.reason !== undefined ? { reason: body.reason ?? null } : {}),
      },
    });
    reply.send(ok(updated));
  });

  app.delete('/api/automod/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const rule = await prisma.automodRule.findUnique({ where: { id } });
    if (!rule) throw TavernError.notFound('Rule not found');
    await requireServerPermission(rule.serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    await prisma.automodRule.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
