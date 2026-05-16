import { z } from 'zod';
import { idSchema } from './ids.js';
import { DICE_LIMITS } from '../constants.js';

export const diceVisibilitySchema = z.enum(['public', 'gm_only', 'private']);

/** Result of a single die: face value plus whether it was kept after kh/kl. */
export const dieResultSchema = z.object({
  value: z.number().int().nonnegative(),
  kept: z.boolean(),
});

/** Result of one term in a notation, e.g. "4d6kh3" or "+5". */
export const diceTermResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dice'),
    count: z.number().int().positive(),
    faces: z.number().int().positive(),
    keep: z
      .object({
        mode: z.enum(['kh', 'kl']),
        amount: z.number().int().positive(),
      })
      .nullable(),
    rolls: z.array(dieResultSchema),
    sign: z.union([z.literal(1), z.literal(-1)]),
    subtotal: z.number().int(),
  }),
  z.object({
    kind: z.literal('modifier',),
    value: z.number().int(),
    sign: z.union([z.literal(1), z.literal(-1)]),
    subtotal: z.number().int(),
  }),
]);

export const diceRollResultSchema = z.object({
  notation: z.string().max(DICE_LIMITS.MAX_NOTATION_LENGTH),
  terms: z.array(diceTermResultSchema),
  total: z.number().int(),
});

export const diceRollSchema = z.object({
  id: idSchema,
  /** Non-null for server rolls; null for DM rolls. */
  serverId: idSchema.nullable(),
  /** Non-null for server rolls; null for DM rolls. */
  channelId: idSchema.nullable(),
  /** Non-null for DM rolls; null for server rolls. */
  dmChannelId: idSchema.nullable(),
  messageId: idSchema.nullable(),
  userId: idSchema,
  notation: z.string().max(DICE_LIMITS.MAX_NOTATION_LENGTH),
  label: z.string().max(120).nullable(),
  result: diceRollResultSchema,
  total: z.number().int(),
  visibility: diceVisibilitySchema,
  createdAt: z.string().datetime(),
});

export const rollDiceRequestSchema = z
  .object({
    /** Server-channel target. Mutually exclusive with `dmChannelId`. */
    channelId: idSchema.optional(),
    /** DM-channel target. Mutually exclusive with `channelId`. */
    dmChannelId: idSchema.optional(),
    notation: z.string().min(1).max(DICE_LIMITS.MAX_NOTATION_LENGTH),
    label: z.string().max(120).optional(),
    visibility: diceVisibilitySchema.default('public'),
  })
  .refine((d) => Boolean(d.channelId) !== Boolean(d.dmChannelId), {
    message: 'exactly one of channelId or dmChannelId is required',
  });

export type DiceVisibility = z.infer<typeof diceVisibilitySchema>;
export type DieResult = z.infer<typeof dieResultSchema>;
export type DiceTermResult = z.infer<typeof diceTermResultSchema>;
export type DiceRollResult = z.infer<typeof diceRollResultSchema>;
export type DiceRoll = z.infer<typeof diceRollSchema>;
export type RollDiceRequest = z.infer<typeof rollDiceRequestSchema>;
