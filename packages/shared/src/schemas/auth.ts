import { z } from 'zod';
import { NAME_LIMITS } from '../constants.js';

export const usernameSchema = z
  .string()
  .min(NAME_LIMITS.MIN_USERNAME)
  .max(NAME_LIMITS.MAX_USERNAME)
  .regex(/^[a-z0-9_.-]+$/i, 'Letters, numbers, dot, dash, and underscore only');

export const passwordSchema = z
  .string()
  .min(NAME_LIMITS.MIN_PASSWORD)
  .max(NAME_LIMITS.MAX_PASSWORD);

export const emailSchema = z.string().email().max(254);

export const inviteCodeSchema = z.string().min(4).max(64);

export const registerRequestSchema = z.object({
  username: usernameSchema,
  displayName: z.string().min(NAME_LIMITS.MIN_DISPLAY_NAME).max(NAME_LIMITS.MAX_DISPLAY_NAME),
  email: emailSchema,
  password: passwordSchema,
  inviteCode: inviteCodeSchema,
});

export const loginRequestSchema = z.object({
  identifier: z.string().min(1).max(254),
  password: passwordSchema,
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshTokenExpiresAt: z.string().datetime(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type TokenPair = z.infer<typeof tokenPairSchema>;
