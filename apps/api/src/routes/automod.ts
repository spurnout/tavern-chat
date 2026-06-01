import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  AUTOMOD_PRESETS,
  findAutomodPreset,
  idSchema,
  Permission,
  TavernError,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';

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

  // ---- Presets (parity gap #4) ------------------------------------------

  // List available presets (metadata only — raw patterns aren't surfaced so
  // the slur seed list isn't echoed back to clients).
  app.get('/api/servers/:id/automod/presets', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const enabled = await prisma.automodRule.findMany({
      where: { serverId, presetId: { not: null } },
      select: { presetId: true },
      distinct: ['presetId'],
    });
    const enabledIds = new Set(enabled.map((r) => r.presetId));
    reply.send(
      ok(
        AUTOMOD_PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          ruleCount: p.rules.length,
          enabled: enabledIds.has(p.id),
        })),
      ),
    );
  });

  // Enable a preset: seed its rules (tagged with presetId). Idempotent — if the
  // preset is already enabled, this is a no-op.
  app.post('/api/servers/:id/automod/presets/:presetId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId, presetId } = z
      .object({ id: idSchema, presetId: z.string().min(1).max(60) })
      .parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);

    const preset = findAutomodPreset(presetId);
    if (!preset) throw TavernError.notFound('Preset not found');

    const already = await prisma.automodRule.count({ where: { serverId, presetId } });
    if (already > 0) {
      reply.send(ok({ presetId, created: 0 }));
      return;
    }

    const maxPos = await prisma.automodRule.aggregate({
      where: { serverId },
      _max: { position: true },
    });
    let pos = (maxPos._max.position ?? -1) + 1;
    await prisma.$transaction(
      preset.rules.map((rule) =>
        prisma.automodRule.create({
          data: {
            id: ulid(),
            serverId,
            name: rule.name,
            kind: rule.kind,
            pattern: rule.pattern,
            action: rule.action,
            enabled: true,
            reason: `Preset: ${preset.label}`,
            presetId,
            createdBy: ctx.userId,
            position: pos++,
          },
        }),
      ),
    );

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'automod.preset_enabled',
      targetType: 'automod_preset',
      targetId: presetId,
      metadata: { label: preset.label, rules: preset.rules.length },
    });

    reply.status(201).send(ok({ presetId, created: preset.rules.length }));
  });

  // Disable a preset: remove its seeded rows as a unit.
  app.delete('/api/servers/:id/automod/presets/:presetId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId, presetId } = z
      .object({ id: idSchema, presetId: z.string().min(1).max(60) })
      .parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const result = await prisma.automodRule.deleteMany({ where: { serverId, presetId } });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'automod.preset_disabled',
      targetType: 'automod_preset',
      targetId: presetId,
    });
    reply.send(ok({ presetId, removed: result.count }));
  });
}
