import { z } from 'zod';
import { idSchema } from './ids.js';
import { presenceSchema } from './presence.js';
import { NAME_LIMITS } from '../constants.js';

export const serverSchema = z.object({
  id: idSchema,
  ownerUserId: idSchema,
  name: z.string().min(NAME_LIMITS.MIN_SERVER_NAME).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  iconAttachmentId: idSchema.nullable(),
  defaultRoleId: idSchema,
  createdAt: z.string().datetime(),
});

export const createServerRequestSchema = z.object({
  name: z.string().min(NAME_LIMITS.MIN_SERVER_NAME).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).optional(),
});

export const updateServerRequestSchema = createServerRequestSchema.partial().extend({
  iconAttachmentId: idSchema.nullable().optional(),
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
