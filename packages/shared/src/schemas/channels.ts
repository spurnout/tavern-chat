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
]);

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
export type Channel = z.infer<typeof channelSchema>;
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>;
export type PermissionOverwrite = z.infer<typeof permissionOverwriteSchema>;
export type UpsertPermissionOverwriteRequest = z.infer<
  typeof upsertPermissionOverwriteRequestSchema
>;
