import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const captionBodySchema = z.object({
  text: z.string().min(1).max(500),
  isFinal: z.boolean(),
});

/**
 * Wave 3 #33 — caption broadcast.
 *
 * A speaker's client posts each transcript chunk (interim or final); the
 * server fans it out via `CAPTION_TEXT` gateway events. We don't persist
 * captions by default — the V1 is a live-only accessibility aid. Persistence
 * is a documented follow-up (CaptionSegment table) for session recaps.
 *
 * The rate limit is intentionally permissive (300/min): interim results
 * fire every ~200ms while someone is speaking, and a long meeting can hit
 * thousands. Cost per call is one database lookup (permission check) + one
 * Redis publish.
 */
export async function registerCaptionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/voice/:channelId/caption', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const body = captionBodySchema.parse(req.body);
      // Caller must be allowed to speak in the channel — captions ride the
      // same gate so they can't be used as a back-channel from a muted
      // listener.
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, username: true },
      });
      if (!me) throw TavernError.notFound('User not found');
      gatewayBroker.publish({
        type: 'CAPTION_TEXT',
        serverId: result.serverId,
        channelId,
        data: {
          channelId,
          userId: ctx.userId,
          displayName: me.displayName || me.username,
          text: body.text,
          isFinal: body.isFinal,
          at: Date.now(),
        },
      });
      reply.send(ok({ ok: true }));
    },
  });
}
