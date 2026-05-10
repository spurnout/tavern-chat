import { z } from 'zod';
import { idSchema } from './ids.js';
import { usernameSchema } from './auth.js';
import { NAME_LIMITS } from '../constants.js';

export const userSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  displayName: z.string().min(NAME_LIMITS.MIN_DISPLAY_NAME).max(NAME_LIMITS.MAX_DISPLAY_NAME),
  avatarAttachmentId: idSchema.nullable(),
  bio: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
});

export const meSchema = userSchema.extend({
  email: z.string().email(),
  isInstanceAdmin: z.boolean(),
  postingLockedUntil: z.string().datetime().nullable(),
  uploadsLockedUntil: z.string().datetime().nullable(),
});

export const updateProfileRequestSchema = z.object({
  displayName: z
    .string()
    .min(NAME_LIMITS.MIN_DISPLAY_NAME)
    .max(NAME_LIMITS.MAX_DISPLAY_NAME)
    .optional(),
  bio: z.string().max(500).optional(),
  avatarAttachmentId: idSchema.nullable().optional(),
});

export type User = z.infer<typeof userSchema>;
export type Me = z.infer<typeof meSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
