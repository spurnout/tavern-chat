import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';

export const campaignStatusSchema = z.enum([
  'planning',
  'active',
  'paused',
  'completed',
  'archived',
]);

export const safetyBoundaryActionSchema = z.enum([
  'allow',
  'fade_to_black',
  'content_warning',
  'requires_consent',
  'block',
]);

export const safetyBoundarySchema = z.object({
  topic: z.string().min(1).max(64),
  action: safetyBoundaryActionSchema,
  note: z.string().max(500).optional(),
});

export const campaignSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  name: z.string().min(NAME_LIMITS.MIN_SERVER_NAME).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  gameSystem: z.string().max(64).nullable(),
  status: campaignStatusSchema,
  gmUserId: idSchema,
  defaultChannelId: idSchema.nullable(),
  rulesJson: z.unknown(),
  safetyBoundaries: z.array(safetyBoundarySchema),
  createdAt: z.string().datetime(),
});

export const createCampaignRequestSchema = z.object({
  name: z.string().min(NAME_LIMITS.MIN_SERVER_NAME).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).optional(),
  gameSystem: z.string().max(64).optional(),
  defaultChannelId: idSchema.optional(),
  safetyBoundaries: z.array(safetyBoundarySchema).optional(),
});

export const updateCampaignRequestSchema = createCampaignRequestSchema.partial().extend({
  status: campaignStatusSchema.optional(),
});

export type CampaignStatus = z.infer<typeof campaignStatusSchema>;
export type SafetyBoundaryAction = z.infer<typeof safetyBoundaryActionSchema>;
export type SafetyBoundary = z.infer<typeof safetyBoundarySchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;
export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequestSchema>;
