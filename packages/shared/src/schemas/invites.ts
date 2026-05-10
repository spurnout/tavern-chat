import { z } from 'zod';
import { idSchema } from './ids.js';

export const inviteScopeSchema = z.enum(['instance', 'server']);

export const inviteSchema = z.object({
  id: idSchema,
  code: z.string(),
  scope: inviteScopeSchema,
  serverId: idSchema.nullable(),
  channelId: idSchema.nullable(),
  createdById: idSchema.nullable(),
  maxUses: z.number().int().positive().nullable(),
  uses: z.number().int().nonnegative(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const createInviteRequestSchema = z.object({
  scope: inviteScopeSchema,
  serverId: idSchema.optional(),
  channelId: idSchema.optional(),
  maxUses: z.number().int().positive().max(10_000).optional(),
  expiresInSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
});

export type InviteScope = z.infer<typeof inviteScopeSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
