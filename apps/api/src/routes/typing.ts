import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idSchema, Permission } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * POST /api/channels/:id/typing
 *
 * Fire-and-forget — broadcasts a TYPING_START event to everyone with
 * VIEW_CHANNEL on this channel. Clients debounce on the send side and
 * expire the indicator after a few seconds on the receive side; the server
 * does not maintain a "currently typing" set.
 */
export async function registerTypingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/channels/:id/typing', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const result = await requireChannelPermission(id, ctx.userId, Permission.SEND_MESSAGES);

      gatewayBroker.publish({
        type: 'TYPING_START',
        serverId: result.serverId,
        channelId: id,
        data: {
          channelId: id,
          serverId: result.serverId,
          userId: ctx.userId,
          startedAt: new Date().toISOString(),
        },
      });

      reply.send(ok({ ok: true }));
    },
  });
}
