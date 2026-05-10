import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';

export const boardGameSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  name: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  minPlayers: z.number().int().positive(),
  maxPlayers: z.number().int().positive(),
  playTimeMinutes: z.number().int().positive().nullable(),
  complexity: z.number().min(1).max(5).nullable(),
  ownerUserId: idSchema.nullable(),
  coverAttachmentId: idSchema.nullable(),
  tags: z.array(z.string().min(1).max(32)),
  createdAt: z.string().datetime(),
});

export const createBoardGameRequestSchema = z.object({
  name: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).optional(),
  minPlayers: z.number().int().positive(),
  maxPlayers: z.number().int().positive(),
  playTimeMinutes: z.number().int().positive().optional(),
  complexity: z.number().min(1).max(5).optional(),
  ownerUserId: idSchema.optional(),
  coverAttachmentId: idSchema.optional(),
  tags: z.array(z.string().min(1).max(32)).optional(),
});

export const updateBoardGameRequestSchema = createBoardGameRequestSchema.partial();

export const filterBoardGamesQuerySchema = z.object({
  players: z.coerce.number().int().positive().optional(),
  maxPlayTimeMinutes: z.coerce.number().int().positive().optional(),
  maxComplexity: z.coerce.number().min(1).max(5).optional(),
  tag: z.string().optional(),
  search: z.string().max(64).optional(),
});

export type BoardGame = z.infer<typeof boardGameSchema>;
export type CreateBoardGameRequest = z.infer<typeof createBoardGameRequestSchema>;
export type UpdateBoardGameRequest = z.infer<typeof updateBoardGameRequestSchema>;
export type FilterBoardGamesQuery = z.infer<typeof filterBoardGamesQuerySchema>;
