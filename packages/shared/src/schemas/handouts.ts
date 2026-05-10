import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';

export const handoutVisibilitySchema = z.enum([
  'public_to_party',
  'gm_only',
  'specific_players',
]);

export const handoutSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  serverId: idSchema,
  authorId: idSchema,
  title: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  body: z.string(),
  attachmentIds: z.array(idSchema),
  visibility: handoutVisibilitySchema,
  visibleToUserIds: z.array(idSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createHandoutRequestSchema = z.object({
  campaignId: idSchema,
  title: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  body: z.string().max(50_000).default(''),
  attachmentIds: z.array(idSchema).optional(),
  visibility: handoutVisibilitySchema.default('public_to_party'),
  visibleToUserIds: z.array(idSchema).optional(),
});

export const updateHandoutRequestSchema = createHandoutRequestSchema
  .omit({ campaignId: true })
  .partial();

export type HandoutVisibility = z.infer<typeof handoutVisibilitySchema>;
export type Handout = z.infer<typeof handoutSchema>;
export type CreateHandoutRequest = z.infer<typeof createHandoutRequestSchema>;
export type UpdateHandoutRequest = z.infer<typeof updateHandoutRequestSchema>;
