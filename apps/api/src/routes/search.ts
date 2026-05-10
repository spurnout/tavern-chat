import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@tavern/db';
import { idSchema, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import {
  filterVisibleChannels,
  getServerPermissions,
} from '../services/permissions-service.js';

const querySchema = z.object({
  q: z.string().min(1).max(200),
  channelId: idSchema.optional(),
  authorId: idSchema.optional(),
  hasAttachment: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * GET /api/servers/:serverId/search?q=...
 *
 * Postgres ILIKE substring search across messages the caller can view. We
 * filter visible channels via the permission resolver so hidden channels
 * never leak into results.
 */
export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:serverId/search', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    if ((await getServerPermissions(serverId, ctx.userId)) === 0n) {
      throw TavernError.notFound();
    }
    const q = querySchema.parse(req.query);

    // Resolve which channels the caller can VIEW.
    const allChannels = await prisma.channel.findMany({
      where: { serverId, type: { in: ['text', 'campaign', 'session'] } },
      select: { id: true },
    });
    const visible = await filterVisibleChannels(allChannels, ctx.userId);
    let visibleIds = visible.map((c) => c.id);
    if (q.channelId) {
      if (!visibleIds.includes(q.channelId)) {
        // Caller can't see the channel they want to search — return empty,
        // not 403, to avoid leaking existence (matches CHANNEL_HIDDEN policy).
        reply.send(ok({ messages: [] }));
        return;
      }
      visibleIds = [q.channelId];
    }
    if (visibleIds.length === 0) {
      reply.send(ok({ messages: [] }));
      return;
    }

    const messages = await prisma.message.findMany({
      where: {
        channelId: { in: visibleIds },
        deletedAt: null,
        // Exclude held/quarantined/blocked content from search results.
        safetyState: { in: ['allowed', 'labeled', 'warning'] },
        content: { contains: q.q, mode: 'insensitive' },
        ...(q.authorId ? { authorId: q.authorId } : {}),
        ...(q.hasAttachment === true ? { attachments: { some: {} } } : {}),
        ...(q.hasAttachment === false ? { attachments: { none: {} } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
      },
    });

    reply.send(
      ok({
        messages: messages.map((m) => serializeMessage(m as MessageRow, ctx.userId)),
      }),
    );
  });
}
