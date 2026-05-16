import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';

const MAX_DRAFT_LENGTH = 8000;

/**
 * Wave 3 #5 — cross-device draft sync.
 *
 * Drafts are per (user, channel). The client debounces writes; the server
 * just stores the latest text and timestamps it. Clearing happens on send
 * via DELETE, but the row is also harmless if it lingers (it just won't
 * match a channel the user can no longer see).
 */
export async function registerDraftRoutes(app: FastifyInstance): Promise<void> {
  // List every draft the caller owns. Returned shape mirrors the client
  // store's `composerDraftByChannelId` so the bootstrap path is a one-liner.
  app.get('/api/me/drafts', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await prisma.messageDraft.findMany({
      where: { userId: ctx.userId },
      select: { channelId: true, content: true, updatedAt: true },
    });
    reply.send(
      ok(
        rows.map((r) => ({
          channelId: r.channelId,
          content: r.content,
          updatedAt: r.updatedAt.toISOString(),
        })),
      ),
    );
  });

  app.put('/api/me/drafts/:channelId', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const body = z
        .object({
          content: z.string().max(MAX_DRAFT_LENGTH),
        })
        .parse(req.body);
      // Permission gate: a draft on a hidden channel would leak the
      // channel's existence on /api/me/drafts. Refuse to store anything for
      // a channel the user can't view. `requireChannelPermission` throws a
      // 404 for hidden channels rather than 403, matching the rest of the
      // codebase's posture against existence leaks.
      try {
        await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);
      } catch {
        throw TavernError.notFound('Channel not found');
      }
      // Empty draft = clear. Saves a row when the user blanks the composer.
      if (body.content.length === 0) {
        await prisma.messageDraft
          .delete({ where: { userId_channelId: { userId: ctx.userId, channelId } } })
          .catch(() => undefined);
        reply.send(ok({ channelId, cleared: true }));
        return;
      }
      const row = await prisma.messageDraft.upsert({
        where: { userId_channelId: { userId: ctx.userId, channelId } },
        create: { userId: ctx.userId, channelId, content: body.content },
        update: { content: body.content },
      });
      reply.send(
        ok({
          channelId,
          content: row.content,
          updatedAt: row.updatedAt.toISOString(),
        }),
      );
    },
  });

  app.delete('/api/me/drafts/:channelId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    await prisma.messageDraft
      .delete({ where: { userId_channelId: { userId: ctx.userId, channelId } } })
      .catch(() => undefined);
    reply.send(ok({ channelId, cleared: true }));
  });
}
