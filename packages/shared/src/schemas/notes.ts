import { z } from 'zod';
import { idSchema } from './ids.js';

export const noteVisibilitySchema = z.enum(['public_to_party', 'gm_only']);

export const campaignNoteSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  serverId: idSchema,
  authorId: idSchema,
  title: z.string().min(1).max(120),
  body: z.string(),
  visibility: noteVisibilitySchema,
  pinned: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createNoteRequestSchema = z.object({
  campaignId: idSchema,
  title: z.string().min(1).max(120),
  body: z.string().max(50_000).default(''),
  visibility: noteVisibilitySchema.default('public_to_party'),
  pinned: z.boolean().optional(),
});

export const updateNoteRequestSchema = createNoteRequestSchema
  .omit({ campaignId: true })
  .partial();

export type NoteVisibility = z.infer<typeof noteVisibilitySchema>;
export type CampaignNote = z.infer<typeof campaignNoteSchema>;
export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;
export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;
