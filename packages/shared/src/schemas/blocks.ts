import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * A member the caller has blocked. Returned by GET /api/users/me/blocks and
 * carried on the BLOCK_ADD gateway event. Blocks are private to the blocker —
 * this shape is never exposed to the blocked member.
 */
export const blockedUserSchema = z.object({
  userId: idSchema,
  user: z.object({
    id: idSchema,
    displayName: z.string(),
    username: z.string(),
  }),
  createdAt: z.string().datetime(),
});

export const blockListSchema = z.array(blockedUserSchema);

export type BlockedUser = z.infer<typeof blockedUserSchema>;
export type BlockList = z.infer<typeof blockListSchema>;
