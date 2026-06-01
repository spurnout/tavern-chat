import { z } from 'zod';
import { idSchema } from './ids.js';
import { presenceSchema } from './presence.js';
import { verificationLevelSchema } from './raid-protection.js';
import { NAME_LIMITS } from '../constants.js';

export const serverSchema = z.object({
  id: idSchema,
  ownerUserId: idSchema,
  name: z.string().min(NAME_LIMITS.MIN_SERVER_NAME).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  iconAttachmentId: idSchema.nullable(),
  /**
   * Resolved, peer-fetchable public URL for the server icon, or null when no
   * icon is set (or a local icon attachment is not yet `ready`). The web
   * renders this as an `<img>` with an initials fallback; the raw
   * `iconAttachmentId` above is retained for edit flows. Optional with a null
   * default for forward-compat with clients pinned to an older server build.
   */
  iconUrl: z.string().url().nullable().default(null),
  defaultRoleId: idSchema,
  /**
   * Federation Phase 3 — per-Tavern opt-in. When false, no messages are
   * fanned out to peers even if a channel's `federationMode` would allow it.
   * Defaults to false on every fresh server (see Prisma schema).
   */
  federationEnabled: z.boolean(),
  /**
   * Federation Phase 4 — mirror provenance. Null on locally-owned servers.
   * Non-null on mirror servers, pointing at the `RemoteInstance.id` of the
   * peer that owns the canonical state. The web UI uses this to render a
   * "federated den" badge and to show a leave button instead of the local
   * federation toggle on the den-settings federation tab.
   *
   * Optional with a default for forward-compat: clients pinned to an older
   * server build will parse new payloads cleanly when the field rolls in,
   * and tests that hand-craft Server fixtures keep working unchanged.
   */
  originInstanceId: idSchema.nullable().default(null),
  /**
   * Resolved host of the origin RemoteInstance (e.g. `a.example`). Set on
   * mirror servers via a JOIN at serialization time so the sidebar can show
   * the host without an extra round-trip. Null on locally-owned servers and
   * also null when the origin row has been deleted (shouldn't happen — the
   * FK uses SetNull on delete — but defence-in-depth here).
   */
  originInstanceHost: z.string().nullable().default(null),
  /**
   * Parity gap #3 — system room for "X joined the tavern" messages. Null when
   * disabled. Optional with a null default for forward-compat with clients
   * pinned to an older server build.
   */
  systemChannelId: idSchema.nullable().default(null),
  /** Parity gap #4 — posting verification gate. Defaults to 'none'. */
  verificationLevel: verificationLevelSchema.default('none'),
  verificationMinAccountAgeHours: z.number().int().min(0).default(0),
  createdAt: z.string().datetime(),
});

export const createServerRequestSchema = z.object({
  name: z.string().min(NAME_LIMITS.MIN_SERVER_NAME).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).optional(),
});

export const updateServerRequestSchema = createServerRequestSchema.partial().extend({
  iconAttachmentId: idSchema.nullable().optional(),
  /**
   * P3-10 — per-Tavern federation toggle. Sent by den-settings UI. The PATCH
   * handler rejects `true` when the instance has `FEDERATION_ENABLED=false`,
   * so flipping it on a non-federated instance is a clean 400 rather than a
   * silently-stored flag that does nothing.
   */
  federationEnabled: z.boolean().optional(),
  /**
   * Parity gap #3 — set/clear the system room. The PATCH handler validates
   * that the channel belongs to this tavern. Null clears it.
   */
  systemChannelId: idSchema.nullable().optional(),
  /** Parity gap #4 — verification tier + account-age threshold (hours). */
  verificationLevel: verificationLevelSchema.optional(),
  verificationMinAccountAgeHours: z.number().int().min(0).max(8760).optional(),
});

export const memberUserSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  username: z.string(),
  presence: presenceSchema.default('offline'),
});

export const memberSchema = z.object({
  serverId: idSchema,
  userId: idSchema,
  user: memberUserSchema,
  nickname: z.string().min(1).max(NAME_LIMITS.MAX_DISPLAY_NAME).nullable(),
  joinedAt: z.string().datetime(),
  timeoutUntil: z.string().datetime().nullable(),
  roles: z.array(idSchema),
});

export type Server = z.infer<typeof serverSchema>;
export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;
export type UpdateServerRequest = z.infer<typeof updateServerRequestSchema>;
export type Member = z.infer<typeof memberSchema>;
