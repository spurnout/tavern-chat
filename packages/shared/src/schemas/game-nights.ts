import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';
import { rsvpStatusSchema } from './sessions.js';

export const gameNightStatusSchema = z.enum([
  'planning',
  'scheduled',
  'live',
  'completed',
  'cancelled',
]);

export const gameNightCandidateSchema = z.object({
  gameNightId: idSchema,
  boardGameId: idSchema,
  proposedById: idSchema,
  voteCount: z.number().int().nonnegative(),
  meVoted: z.boolean(),
});

export const gameNightSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  title: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  scheduledStart: z.string().datetime().nullable(),
  scheduledEnd: z.string().datetime().nullable(),
  location: z.string().max(120).nullable(),
  voiceChannelId: idSchema.nullable(),
  textChannelId: idSchema.nullable(),
  status: gameNightStatusSchema,
  selectedBoardGameId: idSchema.nullable(),
  createdById: idSchema,
  createdAt: z.string().datetime(),
});

export const createGameNightRequestSchema = z.object({
  title: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  location: z.string().max(120).optional(),
  voiceChannelId: idSchema.optional(),
  textChannelId: idSchema.optional(),
  candidateBoardGameIds: z.array(idSchema).optional(),
});

export const updateGameNightRequestSchema = createGameNightRequestSchema.partial().extend({
  status: gameNightStatusSchema.optional(),
  selectedBoardGameId: idSchema.nullable().optional(),
});

export const proposeGameRequestSchema = z.object({
  boardGameId: idSchema,
});

export const voteForGameRequestSchema = z.object({
  boardGameId: idSchema,
});

export const gameNightRsvpRequestSchema = z.object({
  status: rsvpStatusSchema,
});

export type GameNightStatus = z.infer<typeof gameNightStatusSchema>;
export type GameNightCandidate = z.infer<typeof gameNightCandidateSchema>;
export type GameNight = z.infer<typeof gameNightSchema>;
export type CreateGameNightRequest = z.infer<typeof createGameNightRequestSchema>;
export type UpdateGameNightRequest = z.infer<typeof updateGameNightRequestSchema>;
export type ProposeGameRequest = z.infer<typeof proposeGameRequestSchema>;
export type VoteForGameRequest = z.infer<typeof voteForGameRequestSchema>;
export type GameNightRsvpRequest = z.infer<typeof gameNightRsvpRequestSchema>;
