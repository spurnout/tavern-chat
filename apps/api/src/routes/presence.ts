import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail, ok } from '../lib/responses.js';
import {
  clearCustomStatus,
  getPresenceForUser,
  reportActivity,
  setCustomStatus,
  setManualDnd,
} from '../services/presence-service.js';

const patchPresenceBody = z.object({
  /** Client-reported activity (idle timer). `true` = active, `false` = idle. */
  active: z.boolean().optional(),
  /** Sticky DND override. `true` pins presence to `dnd` while online. */
  dnd: z.boolean().optional(),
  /**
   * Custom status string. `null` clears (also clears expiry). `undefined`
   * means "leave unchanged". String length 1-128 chars; the receiver renders
   * via a safe text path so emoji + RTL marks are fine.
   */
  customStatus: z.string().min(1).max(128).nullable().optional(),
  /**
   * Optional ISO datetime at which the custom status auto-clears. `null`
   * means "indefinite". `undefined` means "leave unchanged" (only meaningful
   * when `customStatus` is undefined too; otherwise the explicit set/clear
   * path picks it up). An expiry in the past is a client bug → 400.
   */
  customStatusExpiresAt: z.string().datetime().nullable().optional(),
});

/**
 * PATCH /api/me/presence
 *   { active?: boolean, dnd?: boolean,
 *     customStatus?: string | null, customStatusExpiresAt?: string | null }
 *
 * All fields are independently optional. Clients typically either heartbeat
 * their active state, flip DND, or set/clear a custom status — combining
 * them in a single PATCH is allowed but uncommon.
 *
 * Custom-status semantics:
 *   - `customStatus: 'string'` → set (with optional expiry).
 *   - `customStatus: null` → clear (also clears expiry).
 *   - `customStatus: undefined` → unchanged.
 *   - `customStatusExpiresAt` in the past → 400 `custom_status_expires_in_past`.
 *     We validate at the boundary rather than silently massage; an
 *     expired-on-arrival timestamp is a client bug.
 *
 * GET /api/me/presence
 *   Returns the current presence + manualDnd flag + customStatus +
 *   customStatusExpiresAt for the calling user. Mainly useful at app boot;
 *   subsequent updates come via PRESENCE_UPDATE gateway events.
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

      // Validate expiry-in-past at the boundary BEFORE any persist. We only
      // bother when the client is actually trying to SET a status (not clear
      // and not "leave unchanged"). Clearing with a past expiry is moot since
      // both fields go null, but the explicit guard is cheap.
      if (
        typeof body.customStatus === 'string' &&
        body.customStatusExpiresAt !== undefined &&
        body.customStatusExpiresAt !== null
      ) {
        const expires = new Date(body.customStatusExpiresAt);
        if (expires.getTime() <= Date.now()) {
          return reply
            .code(400)
            .send(fail('VALIDATION_ERROR', 'custom_status_expires_in_past'));
        }
      }

      if (body.dnd !== undefined) {
        await setManualDnd(ctx.userId, body.dnd);
      }
      if (body.active !== undefined) {
        await reportActivity(ctx.userId, body.active);
      }
      if (body.customStatus === null) {
        await clearCustomStatus(ctx.userId);
      } else if (typeof body.customStatus === 'string') {
        const expires =
          body.customStatusExpiresAt === undefined ||
          body.customStatusExpiresAt === null
            ? null
            : new Date(body.customStatusExpiresAt);
        await setCustomStatus(ctx.userId, body.customStatus, expires);
      }

      const state = await getPresenceForUser(ctx.userId);
      reply.send(ok(state));
    },
  });
}
