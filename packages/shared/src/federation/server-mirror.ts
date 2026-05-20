import { z } from 'zod';
import { idSchema } from '../schemas/ids.js';
import { NAME_LIMITS } from '../constants.js';

export const serverUpdatePayloadSchema = z.object({
  serverId: idSchema,
  name: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME).optional(),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable().optional(),
  iconUrl: z.string().url().nullable().optional(),
});

export const channelCreatePayloadSchema = z.object({
  serverId: idSchema,
  channel: z.object({
    id: idSchema,
    name: z.string().min(1).max(NAME_LIMITS.MAX_CHANNEL_NAME),
    type: z.enum(['text', 'forum']),
    topic: z.string().max(NAME_LIMITS.MAX_TOPIC).nullable(),
    position: z.number().int().min(0),
    federationMode: z.enum(['inherit', 'force_on', 'force_off']).default('inherit'),
    nsfw: z.boolean().default(false),
  }),
});

export const channelUpdatePayloadSchema = z.object({
  serverId: idSchema,
  channelId: idSchema,
  name: z.string().min(1).max(NAME_LIMITS.MAX_CHANNEL_NAME).optional(),
  topic: z.string().max(NAME_LIMITS.MAX_TOPIC).nullable().optional(),
  position: z.number().int().min(0).optional(),
  federationMode: z.enum(['inherit', 'force_on', 'force_off']).optional(),
  nsfw: z.boolean().optional(),
});

export const channelDeletePayloadSchema = z.object({
  serverId: idSchema,
  channelId: idSchema,
});

export type ServerUpdatePayload = z.infer<typeof serverUpdatePayloadSchema>;
export type ChannelCreatePayload = z.infer<typeof channelCreatePayloadSchema>;
export type ChannelUpdatePayload = z.infer<typeof channelUpdatePayloadSchema>;
export type ChannelDeletePayload = z.infer<typeof channelDeletePayloadSchema>;
