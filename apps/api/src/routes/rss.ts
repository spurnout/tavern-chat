import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';

const createSchema = z.object({
  url: z.string().url().max(2000),
  feedTitle: z.string().max(120).optional(),
  pollIntervalMinutes: z.number().int().min(5).max(1440).default(15),
});

/**
 * Wave 3 #37 — RSS feed input. Per-channel subscription that the worker
 * polls on an interval and posts new items as webhook-style messages.
 */
export async function registerRssRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/:id/rss', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    const rows = await prisma.rssSubscription.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(ok(rows));
  });

  app.post('/api/channels/:id/rss', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = createSchema.parse(req.body);
    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    const row = await prisma.rssSubscription.create({
      data: {
        id: ulid(),
        channelId,
        url: body.url,
        feedTitle: body.feedTitle ?? null,
        pollIntervalMinutes: body.pollIntervalMinutes,
        createdBy: ctx.userId,
      },
    });
    reply.status(201).send(ok(row));
  });

  app.delete('/api/rss/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.rssSubscription.findUnique({ where: { id } });
    if (!row) throw TavernError.notFound('Subscription not found');
    await requireChannelPermission(row.channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    await prisma.rssSubscription.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
