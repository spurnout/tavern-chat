import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const patchSchema = z.object({
  customStatus: z.string().max(128).nullable(),
});

/**
 * Wave 3 #40 — Per-server custom status. Overrides the global
 * `User.customStatus` when the caller is viewing this server. Stored on
 * `ServerMember.customStatus`.
 */
export async function registerMemberStatusRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/servers/:id/members/me/status', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = patchSchema.parse(req.body);
    // Any member can set their own per-server status.
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);

    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: ctx.userId } },
    });
    if (!member) throw TavernError.notFound('Not a member of this tavern');

    await prisma.serverMember.update({
      where: { serverId_userId: { serverId, userId: ctx.userId } },
      data: { customStatus: body.customStatus },
    });
    gatewayBroker.publish({
      type: 'MEMBER_UPDATE',
      serverId,
      data: { serverId, userId: ctx.userId, customStatus: body.customStatus },
    });
    reply.send(ok({ customStatus: body.customStatus }));
  });
}
