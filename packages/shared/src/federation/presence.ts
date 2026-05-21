import { z } from 'zod';
import { remoteUserIdSchema } from './membership.js';

export const federatedPresenceSchema = z.enum(['active', 'idle', 'dnd', 'offline']);

/**
 * Payload for the `presence.update` federation envelope.
 *
 * Named with a `federated` prefix to disambiguate from the LOCAL
 * `presenceUpdatePayloadSchema` in `../schemas/presence.ts`, which is the
 * gateway broadcast shape ({ userId, presence }) used for in-instance pushes.
 * This federated one carries the home instance's full authoritative view
 * (presence + custom status + watermark) for last-write-wins replication.
 */
export const federatedPresenceUpdatePayloadSchema = z.object({
  userRemoteUserId: remoteUserIdSchema,
  presence: federatedPresenceSchema,
  // Custom status fields are independently nullable — a user can clear their
  // status without changing presence and vice versa. The envelope always
  // carries the FULL current state of both, not a diff.
  customStatus: z.string().min(1).max(128).nullable(),
  customStatusExpiresAt: z.string().datetime().nullable(),
  // Home's authoritative watermark — last-write-wins on the receiver via
  // `incoming.updatedAt <= existing.presenceUpdatedAt` → skip.
  updatedAt: z.string().datetime(),
});

export type FederatedPresenceUpdatePayload = z.infer<
  typeof federatedPresenceUpdatePayloadSchema
>;
export type FederatedPresence = z.infer<typeof federatedPresenceSchema>;
