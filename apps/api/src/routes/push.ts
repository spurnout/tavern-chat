import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  p256dh: z.string().min(8).max(2000),
  auth: z.string().min(8).max(2000),
});

/**
 * Wave 3 #26 — Web Push subscription management. Browsers register a
 * service-worker subscription via the Push API; this route stores it so a
 * worker can dispatch notifications later.
 *
 * Server-side VAPID signing + the actual dispatcher live in the worker
 * (`apps/worker/src/push-dispatcher.ts`). The dispatcher reads from this
 * table on relevant gateway events.
 */
export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/push-subscriptions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await prisma.pushSubscription.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(
      ok(
        rows.map((s) => ({
          id: s.id,
          endpoint: s.endpoint,
          userAgent: s.userAgent,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        })),
      ),
    );
  });

  app.post('/api/me/push-subscriptions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = subscribeSchema.parse(req.body);
    const existing = await prisma.pushSubscription.findUnique({
      where: { endpoint: body.endpoint },
    });
    if (existing) {
      if (existing.userId !== ctx.userId) {
        // Endpoint already belongs to someone else — replace.
        await prisma.pushSubscription.delete({ where: { id: existing.id } });
      } else {
        // Refresh the keys (browsers can rotate them).
        await prisma.pushSubscription.update({
          where: { id: existing.id },
          data: { p256dh: body.p256dh, auth: body.auth, lastUsedAt: new Date() },
        });
        reply.send(ok({ id: existing.id, refreshed: true }));
        return;
      }
    }
    const row = await prisma.pushSubscription.create({
      data: {
        id: ulid(),
        userId: ctx.userId,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        auth: body.auth,
        userAgent:
          typeof req.headers['user-agent'] === 'string'
            ? req.headers['user-agent'].slice(0, 200)
            : null,
      },
    });
    reply.status(201).send(ok({ id: row.id }));
  });

  app.delete('/api/me/push-subscriptions/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.pushSubscription.findUnique({ where: { id } });
    if (!row || row.userId !== ctx.userId) throw TavernError.notFound('Subscription not found');
    await prisma.pushSubscription.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  // Expose the public VAPID key so the SPA can subscribe. The matching
  // private key lives only on the worker.
  app.get('/api/push/vapid-public-key', async (_req, reply) => {
    const key = process.env['VAPID_PUBLIC_KEY'] ?? '';
    reply.send(ok({ publicKey: key }));
  });
}
