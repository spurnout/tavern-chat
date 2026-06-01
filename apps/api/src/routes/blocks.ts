/**
 * Member-block routes (Discord parity gap #1).
 *
 * Blocks are a user-level privacy relationship, not a server permission — so
 * there is no permission gate here beyond "you must be logged in". A block is
 * private to the blocker: BLOCK_ADD / BLOCK_REMOVE are published user-targeted
 * (only `userId` set) so the gateway delivers them solely to the blocker's own
 * sockets (multi-tab sync), never to the blocked member.
 *
 * Enforcement of the block lives elsewhere — the DM-open gate (`dms.ts`) and
 * the mention resolver (`mentions-service.ts`) consult `block-service.ts`.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { listBlocks } from '../services/block-service.js';

export async function registerBlockRoutes(app: FastifyInstance): Promise<void> {
  // List the members the caller has blocked. Loaded by the SPA on boot to
  // drive client-side message/reaction collapse, and rendered in account
  // settings.
  app.get('/api/users/me/blocks', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    reply.send(ok(await listBlocks(ctx.userId)));
  });

  // Block a member. Idempotent — re-blocking is a no-op upsert.
  app.put('/api/users/:userId/block', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { userId: targetId } = z.object({ userId: idSchema }).parse(req.params);
    if (targetId === ctx.userId) {
      throw TavernError.validation('You cannot block yourself');
    }
    // Confirm the target exists so we don't create a dangling block row and
    // so the caller gets a clear 404 rather than a silent success.
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, displayName: true, username: true },
    });
    if (!target) throw TavernError.notFound('Member not found');

    const row = await prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: ctx.userId, blockedId: targetId } },
      create: { blockerId: ctx.userId, blockedId: targetId },
      update: {},
      select: { createdAt: true },
    });

    const dto = {
      userId: target.id,
      user: { id: target.id, displayName: target.displayName, username: target.username },
      createdAt: row.createdAt.toISOString(),
    };
    gatewayBroker.publish({ type: 'BLOCK_ADD', userId: ctx.userId, data: dto });
    reply.send(ok(dto));
  });

  // Unblock a member. Idempotent — the missing-row case is swallowed (mirrors
  // the reaction DELETE narrow P2025 swallow).
  app.delete('/api/users/:userId/block', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { userId: targetId } = z.object({ userId: idSchema }).parse(req.params);
    try {
      await prisma.userBlock.delete({
        where: { blockerId_blockedId: { blockerId: ctx.userId, blockedId: targetId } },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')
      ) {
        throw err;
      }
    }
    gatewayBroker.publish({
      type: 'BLOCK_REMOVE',
      userId: ctx.userId,
      data: { userId: targetId },
    });
    reply.send(ok({ ok: true }));
  });
}
