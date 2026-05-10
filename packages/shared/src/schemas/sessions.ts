import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';

export const campaignSessionStatusSchema = z.enum([
  'planned',
  'live',
  'completed',
  'cancelled',
]);

export const rsvpStatusSchema = z.enum(['yes', 'no', 'maybe', 'late']);

export const campaignSessionSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  serverId: idSchema,
  title: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  scheduledStart: z.string().datetime().nullable(),
  scheduledEnd: z.string().datetime().nullable(),
  voiceChannelId: idSchema.nullable(),
  textChannelId: idSchema.nullable(),
  status: campaignSessionStatusSchema,
  agenda: z.string().nullable(),
  recap: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const createCampaignSessionRequestSchema = z.object({
  campaignId: idSchema,
  title: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  voiceChannelId: idSchema.optional(),
  textChannelId: idSchema.optional(),
  agenda: z.string().max(8000).optional(),
});

export const updateCampaignSessionRequestSchema = createCampaignSessionRequestSchema
  .omit({ campaignId: true })
  .partial()
  .extend({
    status: campaignSessionStatusSchema.optional(),
    recap: z.string().max(16000).optional(),
  });

export const rsvpRequestSchema = z.object({
  status: rsvpStatusSchema,
});

export const rsvpSchema = z.object({
  sessionId: idSchema,
  userId: idSchema,
  status: rsvpStatusSchema,
  updatedAt: z.string().datetime(),
});

export type CampaignSessionStatus = z.infer<typeof campaignSessionStatusSchema>;
export type RsvpStatus = z.infer<typeof rsvpStatusSchema>;
export type CampaignSession = z.infer<typeof campaignSessionSchema>;
export type CreateCampaignSessionRequest = z.infer<typeof createCampaignSessionRequestSchema>;
export type UpdateCampaignSessionRequest = z.infer<typeof updateCampaignSessionRequestSchema>;
export type RsvpRequest = z.infer<typeof rsvpRequestSchema>;
export type Rsvp = z.infer<typeof rsvpSchema>;
