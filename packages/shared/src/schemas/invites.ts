import { z } from 'zod';
import { idSchema } from './ids.js';

export const inviteScopeSchema = z.enum(['instance', 'server']);

/**
 * Federation Phase 4 — cross-instance invite targeting. A non-null remoteScope
 * means the invite is intended for redemption by a user on a peered instance:
 *   - any_peer: any peered instance, any user
 *   - specific_instance: bearer must belong to `remoteInstanceHost`
 *   - specific_user: bearer must match `remoteUserId` ("alice@b.example")
 */
export const remoteInviteScopeSchema = z.enum(['any_peer', 'specific_instance', 'specific_user']);

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
  // Federation Phase 4 — null on local-only invites.
  remoteScope: remoteInviteScopeSchema.nullable(),
  remoteInstanceHost: z.string().nullable(),
  remoteUserId: z.string().nullable(),
});

export const createInviteRequestSchema = z.object({
  scope: inviteScopeSchema,
  serverId: idSchema.optional(),
  channelId: idSchema.optional(),
  maxUses: z.number().int().positive().max(10_000).optional(),
  expiresInSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  // Federation Phase 4 — optional federated targeting fields. Validation rules
  // (e.g. that remoteScope requires scope='server' and a federation-enabled
  // server) live in the route, not the schema, because they depend on DB
  // state (peered RemoteInstance, target Server flags).
  remoteScope: remoteInviteScopeSchema.optional(),
  remoteInstanceHost: z.string().min(1).max(253).optional(),
  remoteUserId: z.string().min(3).max(253).optional(),
});

export type InviteScope = z.infer<typeof inviteScopeSchema>;
export type RemoteInviteScope = z.infer<typeof remoteInviteScopeSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
