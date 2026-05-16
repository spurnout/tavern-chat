import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * PERM-002: ServerBan request/response schemas.
 *
 * A `ServerBan` row hard-blocks a user from a server — they cannot reconnect
 * via the gateway, cannot redeem a server-scoped invite, and any active
 * WebSocket connection is force-closed. `expiresAt` supports temporary bans;
 * `null` is permanent.
 */
export const createBanRequestSchema = z.object({
  userId: idSchema,
  reason: z.string().max(2000).optional(),
  expiresAt: z.string().datetime().optional(),
  /**
   * When true, soft-delete every message authored by the target in this
   * server within the last `deleteWithinHours` (default 24). Mirrors the
   * "also delete last 24 hours of messages" toggle on the ban modal.
   */
  alsoDeleteRecentMessages: z.boolean().optional(),
  deleteWithinHours: z.number().int().min(1).max(168).optional(),
});

export const serverBanSchema = z.object({
  serverId: idSchema,
  userId: idSchema,
  bannedByUserId: idSchema.nullable(),
  reason: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type CreateBanRequest = z.infer<typeof createBanRequestSchema>;
export type ServerBan = z.infer<typeof serverBanSchema>;
