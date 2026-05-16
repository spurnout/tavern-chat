import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createBanRequestSchema,
  idSchema,
  Permission,
  TavernError,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { banMember, listBans, unbanMember } from '../services/ban-service.js';

/**
 * Server ban routes (PERM-002). Gated by the BAN_MEMBERS permission bit; the
 * service itself additionally enforces role hierarchy and protects the owner.
 */
export async function registerBanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:serverId/bans', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.BAN_MEMBERS);
    const bans = await listBans(serverId);
    reply.send(
      ok(
        bans.map((b) => ({
          serverId: b.serverId,
          userId: b.userId,
          bannedByUserId: b.bannedByUserId,
          reason: b.reason,
          expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null,
          createdAt: b.createdAt.toISOString(),
        })),
      ),
    );
  });

  app.post('/api/servers/:serverId/bans', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
      const body = createBanRequestSchema.parse(req.body);
      await requireServerPermission(serverId, ctx.userId, Permission.BAN_MEMBERS);
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt && expiresAt <= new Date()) {
        throw TavernError.validation('Ban expiry must be in the future');
      }
      const sweepRecentHours = body.alsoDeleteRecentMessages
        ? (body.deleteWithinHours ?? 24)
        : null;
      const { messagesDeleted } = await banMember({
        serverId,
        targetUserId: body.userId,
        actorUserId: ctx.userId,
        reason: body.reason ?? null,
        expiresAt,
        sweepRecentHours,
      });
      reply.status(201).send(ok({ serverId, userId: body.userId, messagesDeleted }));
    },
  });

  app.delete('/api/servers/:serverId/bans/:userId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId, userId } = z
      .object({ serverId: idSchema, userId: idSchema })
      .parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.BAN_MEMBERS);
    await unbanMember({ serverId, targetUserId: userId, actorUserId: ctx.userId });
    reply.send(ok({ serverId, userId }));
  });
}
