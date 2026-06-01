import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * Onboarding / welcome-screen schemas (parity gap #3).
 *
 * Config is edited by tavern admins (MANAGE_SERVER); the welcome screen +
 * completion endpoint are member self-serve. Rules acceptance reuses
 * ServerMember.gatePassedAt — there is no separate rules-accepted timestamp.
 */

export const recommendedRoomSchema = z.object({
  channelId: idSchema,
  description: z.string().max(280),
});

export const onboardingPromptOptionSchema = z.object({
  id: idSchema,
  label: z.string().max(80),
  roleId: idSchema.nullable(),
  channelIds: z.array(idSchema).max(20),
  position: z.number().int().min(0),
});

export const onboardingPromptSchema = z.object({
  id: idSchema,
  title: z.string().max(120),
  multiSelect: z.boolean(),
  position: z.number().int().min(0),
  options: z.array(onboardingPromptOptionSchema),
});

/** Full GET /api/servers/:id/onboarding payload. */
export const serverOnboardingSchema = z.object({
  serverId: idSchema,
  enabled: z.boolean(),
  welcomeText: z.string(),
  recommendedRooms: z.array(recommendedRoomSchema),
  requireRules: z.boolean(),
  /** Rules markdown, sourced from JoinGate.rulesMd (empty when no gate). */
  rulesMd: z.string(),
  prompts: z.array(onboardingPromptSchema),
});

/** Body of PUT /api/servers/:id/onboarding (config, minus prompts). */
export const upsertOnboardingSchema = z.object({
  enabled: z.boolean().default(false),
  welcomeText: z.string().max(4000).default(''),
  recommendedRooms: z.array(recommendedRoomSchema).max(10).default([]),
  requireRules: z.boolean().default(false),
});

/** Body of PUT /api/servers/:id/onboarding/prompts (replace-all). */
export const upsertOnboardingPromptsSchema = z.object({
  prompts: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        multiSelect: z.boolean().default(true),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              roleId: idSchema.nullable().default(null),
              channelIds: z.array(idSchema).max(20).default([]),
            }),
          )
          .min(1)
          .max(25),
      }),
    )
    .max(20),
});

/** Body of POST /api/servers/:id/onboarding/complete (member self-serve). */
export const submitOnboardingChoicesSchema = z.object({
  acceptedRules: z.boolean(),
  /** { promptId: optionId[] } — selected options per prompt. */
  selections: z.record(z.array(idSchema)),
});

export type RecommendedRoom = z.infer<typeof recommendedRoomSchema>;
export type OnboardingPrompt = z.infer<typeof onboardingPromptSchema>;
export type ServerOnboarding = z.infer<typeof serverOnboardingSchema>;
export type UpsertOnboardingRequest = z.infer<typeof upsertOnboardingSchema>;
export type UpsertOnboardingPromptsRequest = z.infer<typeof upsertOnboardingPromptsSchema>;
export type SubmitOnboardingChoicesRequest = z.infer<typeof submitOnboardingChoicesSchema>;
