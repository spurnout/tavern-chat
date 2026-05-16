import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';

/**
 * Cold-load endpoint for the Wave-2 link preview cache. The realtime
 * delivery path is `LINK_PREVIEW_READY` from the worker; this route is
 * what the SPA hits when a user lands on a message that's older than the
 * gateway buffer (or simply opens the room cold).
 */
export async function registerLinkPreviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/messages/:id/link-previews', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);

    const message = await prisma.message.findUnique({
      where: { id },
      select: { id: true, channelId: true, dmChannelId: true, deletedAt: true },
    });
    if (!message || message.deletedAt) throw TavernError.notFound('Message not found');

    if (message.channelId) {
      await requireChannelPermission(message.channelId, ctx.userId, Permission.VIEW_CHANNEL);
    } else if (message.dmChannelId) {
      const member = await prisma.dmChannelMember.findUnique({
        where: {
          dmChannelId_userId: { dmChannelId: message.dmChannelId, userId: ctx.userId },
        },
      });
      if (!member) throw TavernError.forbidden();
    }

    const previews = await prisma.linkPreview.findMany({
      where: { messageId: id },
      orderBy: { fetchedAt: 'asc' },
    });
    reply.send(
      ok(
        previews.map((p) => ({
          id: p.id,
          messageId: p.messageId,
          url: p.url,
          title: p.title,
          description: p.description,
          imageUrl: p.imageUrl,
          siteName: p.siteName,
          fetchedAt: p.fetchedAt.toISOString(),
        })),
      ),
    );
  });
}
