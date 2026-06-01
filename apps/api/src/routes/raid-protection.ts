/**
 * Raid / join-protection config routes (parity gap #4).
 *
 * The actual join-velocity measurement + lockdown trip lives in the worker
 * (`raid-watch` job); these routes let an admin configure thresholds and
 * manually lift a lockdown. Enforcement of an active lockdown lives in the
 * invite-join path (`invites.ts`).
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  Permission,
  raidProtectionConfigSchema,
  upsertRaidProtectionSchema,
  type RaidProtectionConfig,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { writeAuditEntry } from '../services/audit-service.js';

function serialize(row: {
  serverId: string;
  enabled: boolean;
  joinWindowSec: number;
  joinThreshold: number;
  lockdownAction: string;
  lockdownActive: boolean;
  lockdownEndsAt: Date | null;
}): RaidProtectionConfig {
  return raidProtectionConfigSchema.parse({
    serverId: row.serverId,
    enabled: row.enabled,
    joinWindowSec: row.joinWindowSec,
    joinThreshold: row.joinThreshold,
    lockdownAction: row.lockdownAction,
    lockdownActive: row.lockdownActive,
    lockdownEndsAt: row.lockdownEndsAt ? row.lockdownEndsAt.toISOString() : null,
  });
}

export async function registerRaidProtectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/raid-protection', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const row = await prisma.raidProtectionConfig.findUnique({ where: { serverId } });
    reply.send(
      ok(
        row
          ? serialize(row)
          : serialize({
              serverId,
              enabled: false,
              joinWindowSec: 60,
              joinThreshold: 10,
              lockdownAction: 'require_approval',
              lockdownActive: false,
              lockdownEndsAt: null,
            }),
      ),
    );
  });

  app.put('/api/servers/:id/raid-protection', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = upsertRaidProtectionSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const row = await prisma.raidProtectionConfig.upsert({
      where: { serverId },
      create: {
        serverId,
        enabled: body.enabled,
        joinWindowSec: body.joinWindowSec,
        joinThreshold: body.joinThreshold,
        lockdownAction: body.lockdownAction,
      },
      update: {
        enabled: body.enabled,
        joinWindowSec: body.joinWindowSec,
        joinThreshold: body.joinThreshold,
        lockdownAction: body.lockdownAction,
      },
    });
    reply.send(ok(serialize(row)));
  });

  // Manual all-clear.
  app.post('/api/servers/:id/raid-protection/lift', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const existing = await prisma.raidProtectionConfig.findUnique({ where: { serverId } });
    if (!existing) {
      reply.send(ok({ ok: true }));
      return;
    }
    const row = await prisma.raidProtectionConfig.update({
      where: { serverId },
      data: { lockdownActive: false, lockdownEndsAt: null },
    });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'raid.lockdown_lifted',
      targetType: 'server',
      targetId: serverId,
    });
    gatewayBroker.publish({
      type: 'SERVER_LOCKDOWN',
      serverId,
      data: {
        serverId,
        active: false,
        action: row.lockdownAction,
        endsAt: null,
      },
    });
    reply.send(ok(serialize(row)));
  });
}
