import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * Raid protection + verification schemas (parity gap #4).
 */

export const lockdownActionSchema = z.enum([
  'require_approval',
  'pause_invites',
  'quarantine',
]);

export const raidProtectionConfigSchema = z.object({
  serverId: idSchema,
  enabled: z.boolean(),
  joinWindowSec: z.number().int().min(5).max(3600),
  joinThreshold: z.number().int().min(2).max(1000),
  lockdownAction: lockdownActionSchema,
  lockdownActive: z.boolean(),
  lockdownEndsAt: z.string().datetime().nullable(),
});

/** Body of PUT /api/servers/:id/raid-protection. */
export const upsertRaidProtectionSchema = z.object({
  enabled: z.boolean().default(false),
  joinWindowSec: z.number().int().min(5).max(3600).default(60),
  joinThreshold: z.number().int().min(2).max(1000).default(10),
  lockdownAction: lockdownActionSchema.default('require_approval'),
});

export const verificationLevelSchema = z.enum([
  'none',
  'email_verified',
  'account_age',
  'must_pass_gate',
]);

/** SERVER_LOCKDOWN gateway payload. */
export const serverLockdownPayloadSchema = z.object({
  serverId: idSchema,
  active: z.boolean(),
  action: lockdownActionSchema,
  endsAt: z.string().datetime().nullable(),
});

export type LockdownAction = z.infer<typeof lockdownActionSchema>;
export type RaidProtectionConfig = z.infer<typeof raidProtectionConfigSchema>;
export type UpsertRaidProtectionRequest = z.infer<typeof upsertRaidProtectionSchema>;
export type VerificationLevel = z.infer<typeof verificationLevelSchema>;
export type ServerLockdownPayload = z.infer<typeof serverLockdownPayloadSchema>;
