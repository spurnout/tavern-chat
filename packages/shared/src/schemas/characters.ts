import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * Wave 2 #11 — character sheets.
 *
 * `system` switches the shape validation for `sheetJson`. Generic is a
 * free-form text bag for systems we haven't modeled yet; D&D 5e gets
 * stronger validation so the renderer can rely on the structure.
 */

export const characterSystemSchema = z.enum(['dnd5e', 'pbta', 'generic']);
export type CharacterSystem = z.infer<typeof characterSystemSchema>;

// ----- D&D 5e -----------------------------------------------------------

const dnd5eAbilityScoreSchema = z.object({
  score: z.number().int().min(1).max(30).default(10),
  proficient: z.boolean().default(false),
});

export const dnd5eSheetSchema = z.object({
  level: z.number().int().min(1).max(30).default(1),
  className: z.string().max(40).default(''),
  race: z.string().max(40).default(''),
  background: z.string().max(40).default(''),
  alignment: z.string().max(40).default(''),
  experience: z.number().int().min(0).default(0),
  proficiencyBonus: z.number().int().min(2).max(6).default(2),
  inspiration: z.boolean().default(false),
  armorClass: z.number().int().min(0).max(40).default(10),
  initiativeBonus: z.number().int().min(-10).max(20).default(0),
  speed: z.number().int().min(0).max(120).default(30),
  hitPoints: z
    .object({
      current: z.number().int().min(-99).max(999).default(0),
      max: z.number().int().min(0).max(999).default(0),
      temporary: z.number().int().min(0).max(999).default(0),
    })
    .default({}),
  hitDice: z.string().max(40).default(''),
  deathSaves: z
    .object({
      successes: z.number().int().min(0).max(3).default(0),
      failures: z.number().int().min(0).max(3).default(0),
    })
    .default({}),
  abilities: z
    .object({
      str: dnd5eAbilityScoreSchema.default({}),
      dex: dnd5eAbilityScoreSchema.default({}),
      con: dnd5eAbilityScoreSchema.default({}),
      int: dnd5eAbilityScoreSchema.default({}),
      wis: dnd5eAbilityScoreSchema.default({}),
      cha: dnd5eAbilityScoreSchema.default({}),
    })
    .default({}),
  skills: z
    .record(
      z.object({
        proficient: z.boolean().default(false),
        expertise: z.boolean().default(false),
      }),
    )
    .default({}),
  inventory: z
    .array(
      z.object({
        name: z.string().max(60),
        quantity: z.number().int().min(0).default(1),
        notes: z.string().max(280).optional(),
      }),
    )
    .default([]),
  notes: z.string().max(8000).default(''),
});

// ----- Generic / PbtA ---------------------------------------------------

export const genericSheetSchema = z.object({
  pronouns: z.string().max(40).default(''),
  description: z.string().max(8000).default(''),
  stats: z
    .array(
      z.object({
        label: z.string().max(40),
        value: z.string().max(60),
      }),
    )
    .default([]),
  notes: z.string().max(8000).default(''),
});

export const pbtaSheetSchema = z.object({
  playbook: z.string().max(60).default(''),
  hx: z.array(z.object({ name: z.string().max(40), value: z.number().int().min(-3).max(3) })).default([]),
  stats: z
    .object({
      cool: z.number().int().min(-3).max(3).default(0),
      hard: z.number().int().min(-3).max(3).default(0),
      hot: z.number().int().min(-3).max(3).default(0),
      sharp: z.number().int().min(-3).max(3).default(0),
      weird: z.number().int().min(-3).max(3).default(0),
    })
    .default({}),
  moves: z.array(z.object({ name: z.string().max(60), description: z.string().max(1000) })).default([]),
  notes: z.string().max(8000).default(''),
});

export const characterSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  ownerUserId: idSchema,
  name: z.string().min(1).max(80),
  conceptOneLiner: z.string().max(200).nullable(),
  system: characterSystemSchema,
  sheetJson: z.unknown(),
  portraitAttachmentId: idSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createCharacterRequestSchema = z.object({
  name: z.string().min(1).max(80),
  conceptOneLiner: z.string().max(200).optional(),
  system: characterSystemSchema.default('dnd5e'),
  portraitAttachmentId: idSchema.optional(),
});

export const updateCharacterRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  conceptOneLiner: z.string().max(200).nullable().optional(),
  portraitAttachmentId: idSchema.nullable().optional(),
  sheetJson: z.unknown().optional(),
});

export type Character = z.infer<typeof characterSchema>;
export type CreateCharacterRequest = z.infer<typeof createCharacterRequestSchema>;
export type UpdateCharacterRequest = z.infer<typeof updateCharacterRequestSchema>;

/**
 * Validate sheetJson against the schema appropriate to `system`. Returns the
 * parsed value (with defaults filled in) or throws a ZodError.
 */
export function validateSheetForSystem(system: CharacterSystem, sheetJson: unknown): unknown {
  switch (system) {
    case 'dnd5e':
      return dnd5eSheetSchema.parse(sheetJson ?? {});
    case 'pbta':
      return pbtaSheetSchema.parse(sheetJson ?? {});
    case 'generic':
    default:
      return genericSheetSchema.parse(sheetJson ?? {});
  }
}

// ----- Macros -----------------------------------------------------------

export const characterMacroSchema = z.object({
  id: idSchema,
  characterId: idSchema,
  label: z.string().min(1).max(60),
  notation: z.string().min(1).max(200),
  modifierJson: z.unknown(),
  position: z.number().int().min(0),
  color: z.string().max(7).nullable(),
});

export const createMacroRequestSchema = z.object({
  label: z.string().min(1).max(60),
  notation: z.string().min(1).max(200),
  modifierJson: z.unknown().optional(),
  color: z.string().max(7).optional(),
});

export const updateMacroRequestSchema = createMacroRequestSchema.partial();

export type CharacterMacro = z.infer<typeof characterMacroSchema>;
