import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../lib/responses.js';
import {
  getPresenceForUser,
  reportActivity,
  setManualDnd,
} from '../services/presence-service.js';

const patchPresenceBody = z.object({
  /** Client-reported activity (idle timer). `true` = active, `false` = idle. */
  active: z.boolean().optional(),
  /** Sticky DND override. `true` pins presence to `dnd` while online. */
  dnd: z.boolean().optional(),
});

/**
 * PATCH /api/me/presence
 *   { active?: boolean, dnd?: boolean }
 *
 * Both fields are optional and may be sent together; clients typically
 * either heartbeat their active state OR flip DND, never both.
 *
 * GET /api/me/presence
 *   Returns the current presence + manualDnd flag for the calling user.
 *   Mainly useful at app boot; subsequent updates come via PRESENCE_UPDATE
 *   gateway events.
 */
export async function registerPresenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/presence', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const state = await getPresenceForUser(ctx.userId);
      reply.send(ok(state));
    },
  });

  app.patch('/api/me/presence', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const body = patchPresenceBody.parse(req.body);
      if (body.dnd !== undefined) {
        await setManualDnd(ctx.userId, body.dnd);
      }
      if (body.active !== undefined) {
        await reportActivity(ctx.userId, body.active);
      }
      const state = await getPresenceForUser(ctx.userId);
      reply.send(ok(state));
    },
  });
}
