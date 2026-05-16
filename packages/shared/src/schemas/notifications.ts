import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * Global notification preferences. Defaults match the Prisma column
 * defaults so a freshly-created user has sensible behavior even before the
 * first PATCH lands.
 */
export const userNotificationPreferenceSchema = z.object({
  soundEnabled: z.boolean(),
  /** 0..100. Master gain for synthesized notification sounds. */
  volume: z.number().int().min(0).max(100),
  chatSoundsWhileInVoice: z.boolean(),
  playOnlyWhenUnfocused: z.boolean(),
  mentionsOverrideMute: z.boolean(),
  /** Wave 3 #31 — snooze all notifications until this ISO timestamp. */
  snoozeUntil: z.string().datetime().nullable().optional(),
  /** Wave 3 #31 — daily quiet hours, "HH:mm" in the user's timezone. */
  quietHoursStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Must be HH:mm')
    .nullable()
    .optional(),
  quietHoursEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Must be HH:mm')
    .nullable()
    .optional(),
  /** Wave 3 #31 — weekdays (0=Sun..6=Sat) quiet hours apply. Empty = all. */
  quietHoursDays: z.array(z.number().int().min(0).max(6)).optional(),
});

export const updateUserNotificationPreferenceRequestSchema =
  userNotificationPreferenceSchema.partial();

/**
 * Per-tavern overrides. Composite identity is implicit (the URL carries
 * serverId; the calling user is the authenticated caller).
 */
export const serverMemberNotificationPreferenceSchema = z.object({
  serverId: idSchema,
  muteAll: z.boolean(),
  muteMessages: z.boolean(),
  muteMentions: z.boolean(),
});

export const updateServerMemberNotificationPreferenceRequestSchema =
  serverMemberNotificationPreferenceSchema.omit({ serverId: true }).partial();

export type UserNotificationPreference = z.infer<typeof userNotificationPreferenceSchema>;
export type UpdateUserNotificationPreferenceRequest = z.infer<
  typeof updateUserNotificationPreferenceRequestSchema
>;
export type ServerMemberNotificationPreference = z.infer<
  typeof serverMemberNotificationPreferenceSchema
>;
export type UpdateServerMemberNotificationPreferenceRequest = z.infer<
  typeof updateServerMemberNotificationPreferenceRequestSchema
>;
