import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';

export const channelTypeSchema = z.enum([
  'category',
  'text',
  'voice',
  'campaign',
  'session',
  'board_game',
  /** Wave 3 #24 — broadcast voice channel with speaker/listener tiers. */
  'stage',
  /** Wave 3 #8 — forum: each root post auto-seeds a thread. */
  'forum',
]);

/** Federation Phase 3 (P3-11) — per-channel override of the parent
 * server's federationEnabled flag. `inherit` defers to the den; the
 * `force_*` values pin the room regardless of the den setting. */
export const federationModeSchema = z.enum(['inherit', 'force_on', 'force_off']);

export const channelSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  parentId: idSchema.nullable(),
  campaignId: idSchema.nullable(),
  gameNightId: idSchema.nullable(),
  type: channelTypeSchema,
  name: z.string().min(NAME_LIMITS.MIN_CHANNEL_NAME).max(NAME_LIMITS.MAX_CHANNEL_NAME),
  topic: z.string().max(NAME_LIMITS.MAX_TOPIC).nullable(),
  position: z.number().int().min(0),
  nsfw: z.boolean(),
  videoEnabled: z.boolean(),
  federationMode: federationModeSchema,
  createdAt: z.string().datetime(),
});

export const createChannelRequestSchema = z.object({
  type: channelTypeSchema,
  name: z.string().min(NAME_LIMITS.MIN_CHANNEL_NAME).max(NAME_LIMITS.MAX_CHANNEL_NAME),
  parentId: idSchema.nullable().optional(),
  topic: z.string().max(NAME_LIMITS.MAX_TOPIC).optional(),
  nsfw: z.boolean().optional(),
  videoEnabled: z.boolean().optional(),
});

export const updateChannelRequestSchema = createChannelRequestSchema
  .omit({ type: true })
  .partial()
  .extend({
    position: z.number().int().min(0).optional(),
    /** Wave 2 #8 — slow mode in seconds. */
    slowmodeSeconds: z.number().int().min(0).max(6 * 60 * 60).optional(),
    /** Wave 2 #9 — posting scope. */
    postingScope: z.enum(['open', 'mods_only', 'admin_only']).optional(),
    /** Federation Phase 3 (P3-11) — per-channel federation override. */
    federationMode: federationModeSchema.optional(),
  });

export const permissionOverwriteTargetTypeSchema = z.enum(['role', 'user']);

export const permissionOverwriteSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  targetType: permissionOverwriteTargetTypeSchema,
  targetId: idSchema,
  allow: z.string(),
  deny: z.string(),
});

export const upsertPermissionOverwriteRequestSchema = z.object({
  targetType: permissionOverwriteTargetTypeSchema,
  targetId: idSchema,
  allow: z.string(),
  deny: z.string(),
});

export type ChannelType = z.infer<typeof channelTypeSchema>;
export type FederationMode = z.infer<typeof federationModeSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>;
export type PermissionOverwrite = z.infer<typeof permissionOverwriteSchema>;
export type UpsertPermissionOverwriteRequest = z.infer<
  typeof upsertPermissionOverwriteRequestSchema
>;
