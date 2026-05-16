import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const strokeSchema = z.object({
  id: z.string().min(1).max(80),
  points: z.array(z.tuple([z.number(), z.number()])).min(1).max(2000),
  color: z.string().min(1).max(20),
  width: z.number().min(0.5).max(64),
  kind: z.enum(['pen', 'eraser']),
});

/**
 * Wave 3 #34 — whiteboard routes.
 *
 * GET returns the current full state; PATCH writes a full snapshot (used
 * for periodic compaction); POST /stroke is the realtime path that
 * broadcasts an individual stroke + appends it to the persisted state.
 * DELETE /clear empties the canvas + broadcasts WHITEBOARD_CLEAR.
 *
 * No OT/CRDT — last write wins per stroke. Acceptable for small groups
 * taking turns; multi-user simultaneous drawing produces no conflict
 * since each stroke is a distinct object.
 */
export async function registerWhiteboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/:channelId/whiteboard', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);
    const row = await prisma.whiteboard.findUnique({ where: { channelId } });
    if (!row) {
      reply.send(ok({ channelId, strokes: [], updatedBy: null, updatedAt: null }));
      return;
    }
    reply.send(
      ok({
        channelId,
        strokes: parseStrokes(row.strokesJson),
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      }),
    );
  });

  app.post('/api/channels/:channelId/whiteboard/stroke', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const body = z.object({ stroke: strokeSchema }).parse(req.body);
      const result = await requireChannelPermission(
        channelId,
        ctx.userId,
        Permission.SEND_MESSAGES,
      );
      const existing = await prisma.whiteboard.findUnique({ where: { channelId } });
      const strokes = existing ? parseStrokes(existing.strokesJson) : [];
      strokes.push(body.stroke);
      // Cap stored strokes at 5000 so a runaway drawer doesn't blow JSONB.
      // Old strokes drop off the front when the cap is exceeded.
      const trimmed = strokes.slice(-5000);
      if (existing) {
        await prisma.whiteboard.update({
          where: { channelId },
          data: { strokesJson: trimmed, updatedBy: ctx.userId },
        });
      } else {
        await prisma.whiteboard.create({
          data: {
            id: ulid(),
            channelId,
            strokesJson: trimmed,
            updatedBy: ctx.userId,
          },
        });
      }
      gatewayBroker.publish({
        type: 'WHITEBOARD_STROKE',
        serverId: result.serverId,
        channelId,
        data: { channelId, stroke: body.stroke, by: ctx.userId },
      });
      reply.send(ok({ ok: true }));
    },
  });

  app.delete('/api/channels/:channelId/whiteboard', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    const result = await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_MESSAGES);
    await prisma.whiteboard
      .delete({ where: { channelId } })
      .catch(() => undefined);
    gatewayBroker.publish({
      type: 'WHITEBOARD_CLEAR',
      serverId: result.serverId,
      channelId,
      data: { channelId, by: ctx.userId },
    });
    reply.send(ok({ ok: true }));
  });
}

function parseStrokes(json: unknown): Array<z.infer<typeof strokeSchema>> {
  if (!Array.isArray(json)) return [];
  const out: Array<z.infer<typeof strokeSchema>> = [];
  for (const s of json) {
    const parsed = strokeSchema.safeParse(s);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
