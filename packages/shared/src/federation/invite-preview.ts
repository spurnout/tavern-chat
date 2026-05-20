/**
 * Federation Phase 4 — `GET /_federation/invite-preview/:code` response schema.
 *
 * Public, unauthenticated endpoint served by the *home* instance (the one
 * that minted the invite). When a user redeems an invite on their own
 * (receiving) instance, the receiving instance fetches this on the user's
 * behalf so it can show "you're about to join `Federated Tavern` on
 * `a.example`" before initiating the actual join.
 *
 * The schema is exported from the shared package so the P4-6 client and
 * future UI surfaces can parse the response without redefining the wire
 * shape. The corresponding route lives in
 * `apps/api/src/routes/federation-invite-preview.ts`.
 *
 * Wire URL format for `iconUrl` (matches FederationProfileService.deriveAvatarUrl):
 *   `https://{selfHost}/api/attachments/{iconAttachmentId}`
 */

import { z } from 'zod';
import { idSchema } from '../schemas/ids.js';
import { NAME_LIMITS } from '../constants.js';

export const federatedInvitePreviewSchema = z.object({
  serverId: idSchema,
  name: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  iconUrl: z.string().url().nullable(),
  /** Qualified `localpart@host` id of the server's owner on the home instance. */
  ownerRemoteUserId: z.string().min(3).max(253),
  /** Qualified `localpart@host` id of the user who minted this invite. */
  inviterRemoteUserId: z.string().min(3).max(253),
  /**
   * Total channel count on the server. The receiving instance shows this in
   * the join confirmation; per-channel federation gating still applies once
   * the user actually joins.
   */
  channelCount: z.number().int().nonnegative(),
});

export type FederatedInvitePreview = z.infer<typeof federatedInvitePreviewSchema>;
