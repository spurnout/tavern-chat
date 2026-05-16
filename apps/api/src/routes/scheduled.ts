import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import {
  cancelDispatch,
  scheduleDispatch,
} from '../services/scheduler.js';

const messagePayloadSchema = z.object({
  content: z.string().min(1).max(4000),
});

const reminderPayloadSchema = z.object({
  text: z.string().min(1).max(280),
});

const createBodySchema = z
  .object({
    kind: z.enum(['message', 'reminder']),
    channelId: idSchema.optional(),
    payload: z.unknown(),
    dispatchAt: z.string().datetime(),
  })
  .superRefine((data, ctx) => {
    const at = new Date(data.dispatchAt);
    if (Number.isNaN(at.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dispatchAt must be a valid ISO timestamp',
      });
      return;
    }
    if (at.getTime() <= Date.now() + 5_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dispatchAt must be at least 5 seconds in the future',
      });
    }
    if (data.kind === 'message' && !data.channelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channelId is required for scheduled messages',
      });
    }
  });

const patchBodySchema = z.object({
  payload: z.unknown().optional(),
  dispatchAt: z.string().datetime().optional(),
});

export async function registerScheduledRoutes(app: FastifyInstance): Promise<void> {
  // ---- List mine -------------------------------------------------------
  app.get('/api/me/scheduled', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await prisma.scheduledDispatch.findMany({
      where: { userId: ctx.userId },
      orderBy: { dispatchAt: 'asc' },
      take: 100,
    });
    reply.send(
      ok(
        rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          channelId: r.channelId,
          dmChannelId: r.dmChannelId,
          payload: r.payload,
          dispatchAt: r.dispatchAt.toISOString(),
          status: r.status,
          sentMessageId: r.sentMessageId,
          failureReason: r.failureReason,
          createdAt: r.createdAt.toISOString(),
        })),
      ),
    );
  });

  // ---- Create ----------------------------------------------------------
  app.post('/api/me/scheduled', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createBodySchema.parse(req.body);

    let payload: unknown;
    if (body.kind === 'message') {
      payload = messagePayloadSchema.parse(body.payload);
      // Confirm the user can post in the target channel right now; the
      // server re-checks at dispatch time but this gives the user fast
      // feedback if they pick a room they can't post in.
      await requireChannelPermission(body.channelId!, ctx.userId, Permission.SEND_MESSAGES);
    } else {
      payload = reminderPayloadSchema.parse(body.payload);
    }

    const id = ulid();
    const dispatchAt = new Date(body.dispatchAt);
    const row = await prisma.scheduledDispatch.create({
      data: {
        id,
        userId: ctx.userId,
        kind: body.kind,
        channelId: body.channelId ?? null,
        payload: payload as object,
        dispatchAt,
      },
    });
    scheduleDispatch(id, dispatchAt);

    reply.status(201).send(
      ok({
        id: row.id,
        kind: row.kind,
        channelId: row.channelId,
        payload: row.payload,
        dispatchAt: row.dispatchAt.toISOString(),
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  });

  // ---- Patch -----------------------------------------------------------
  app.patch('/api/me/scheduled/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = patchBodySchema.parse(req.body);

    const existing = await prisma.scheduledDispatch.findUnique({ where: { id } });
    if (!existing || existing.userId !== ctx.userId) {
      throw TavernError.notFound('Scheduled dispatch not found');
    }
    if (existing.status !== 'pending') {
      throw TavernError.validation('Already dispatched');
    }

    const next: { payload?: unknown; dispatchAt?: Date } = {};
    if (body.payload !== undefined) next.payload = body.payload;
    if (body.dispatchAt !== undefined) {
      const at = new Date(body.dispatchAt);
      if (at.getTime() <= Date.now() + 5_000) {
        throw TavernError.validation('dispatchAt must be at least 5 seconds in the future');
      }
      next.dispatchAt = at;
    }

    const row = await prisma.scheduledDispatch.update({
      where: { id },
      data: {
        ...(next.payload !== undefined ? { payload: next.payload as object } : {}),
        ...(next.dispatchAt ? { dispatchAt: next.dispatchAt } : {}),
      },
    });
    if (next.dispatchAt) scheduleDispatch(id, row.dispatchAt);

    reply.send(
      ok({
        id: row.id,
        kind: row.kind,
        channelId: row.channelId,
        payload: row.payload,
        dispatchAt: row.dispatchAt.toISOString(),
        status: row.status,
      }),
    );
  });

  // ---- Cancel ----------------------------------------------------------
  app.delete('/api/me/scheduled/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.scheduledDispatch.findUnique({ where: { id } });
    if (!existing || existing.userId !== ctx.userId) {
      throw TavernError.notFound('Scheduled dispatch not found');
    }
    if (existing.status === 'pending') {
      await prisma.scheduledDispatch.update({
        where: { id },
        data: { status: 'cancelled' },
      });
      cancelDispatch(id);
    }
    reply.send(ok({ id, status: 'cancelled' }));
  });
}
