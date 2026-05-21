import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * User presence states. `active`, `idle`, `offline` are derived by the
 * gateway from socket connection state + heartbeat freshness. `dnd` is set
 * via `PATCH /me/presence` and overrides the derived state for as long as
 * the user has the manual override on.
 */
export const presenceSchema = z.enum(['active', 'idle', 'dnd', 'offline']);

/**
 * Server -> client broadcast when a member's presence changes.
 *
 * `customStatus` and `customStatusExpiresAt` are optional so existing emitters
 * that only know about presence (gateway lifecycle, idle reports) keep working
 * untouched. Receivers MUST treat absent fields as "no change" — they must NOT
 * clobber a previously-known custom status when an emitter omits the field.
 * Set the field to `null` explicitly to clear.
 */
export const presenceUpdatePayloadSchema = z.object({
  userId: idSchema,
  presence: presenceSchema,
  customStatus: z.string().min(1).max(128).nullable().optional(),
  customStatusExpiresAt: z.string().datetime().nullable().optional(),
});

/**
 * Manual DND toggle. `dnd: true` pins the user's presence to `dnd` until
 * they clear it; `dnd: false` releases the override and lets the gateway
 * resume deriving presence from socket / heartbeat state.
 */
export const updatePresenceRequestSchema = z.object({
  dnd: z.boolean(),
});

export type Presence = z.infer<typeof presenceSchema>;
export type PresenceUpdatePayload = z.infer<typeof presenceUpdatePayloadSchema>;
export type UpdatePresenceRequest = z.infer<typeof updatePresenceRequestSchema>;
