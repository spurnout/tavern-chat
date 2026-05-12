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
