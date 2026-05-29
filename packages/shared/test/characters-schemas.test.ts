import { describe, expect, it } from 'vitest';
import {
  characterMacroSchema,
  characterSchema,
  characterSystemSchema,
  createCharacterRequestSchema,
  createMacroRequestSchema,
  dnd5eSheetSchema,
  genericSheetSchema,
  pbtaSheetSchema,
  updateCharacterRequestSchema,
  updateMacroRequestSchema,
  validateSheetForSystem,
} from '../src/schemas/characters.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('characterSystemSchema', () => {
  it.each(['dnd5e', 'pbta', 'generic'])('accepts %s', (v) => {
    expect(characterSystemSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown system', () => {
    expect(characterSystemSchema.safeParse('gurps').success).toBe(false);
  });
});

describe('dnd5eSheetSchema', () => {
  it('fills every default for an empty object', () => {
    const parsed = dnd5eSheetSchema.parse({});
    expect(parsed.level).toBe(1);
    expect(parsed.className).toBe('');
    expect(parsed.proficiencyBonus).toBe(2);
    expect(parsed.armorClass).toBe(10);
    expect(parsed.speed).toBe(30);
    expect(parsed.hitPoints).toEqual({ current: 0, max: 0, temporary: 0 });
    expect(parsed.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(parsed.abilities.str).toEqual({ score: 10, proficient: false });
    expect(parsed.skills).toEqual({});
    expect(parsed.inventory).toEqual([]);
    expect(parsed.notes).toBe('');
  });

  it('accepts a fully specified sheet with nested records and inventory', () => {
    const result = dnd5eSheetSchema.safeParse({
      level: 5,
      className: 'Wizard',
      race: 'Elf',
      background: 'Sage',
      alignment: 'CG',
      experience: 6500,
      proficiencyBonus: 3,
      inspiration: true,
      armorClass: 15,
      initiativeBonus: 2,
      speed: 30,
      hitPoints: { current: 22, max: 28, temporary: 4 },
      hitDice: '5d6',
      deathSaves: { successes: 1, failures: 2 },
      abilities: {
        str: { score: 8, proficient: false },
        dex: { score: 16, proficient: true },
        con: { score: 14, proficient: false },
        int: { score: 18, proficient: true },
        wis: { score: 12, proficient: false },
        cha: { score: 10, proficient: false },
      },
      skills: { arcana: { proficient: true, expertise: false } },
      inventory: [{ name: 'Spellbook', quantity: 1, notes: 'leather bound' }],
      notes: 'A studious mage.',
    });
    expect(result.success).toBe(true);
  });

  it('defaults inventory item quantity to 1', () => {
    const parsed = dnd5eSheetSchema.parse({ inventory: [{ name: 'Torch' }] });
    expect(parsed.inventory[0]?.quantity).toBe(1);
  });

  it('rejects an ability score above 30', () => {
    expect(
      dnd5eSheetSchema.safeParse({ abilities: { str: { score: 31 } } }).success,
    ).toBe(false);
  });

  it('rejects a level below 1', () => {
    expect(dnd5eSheetSchema.safeParse({ level: 0 }).success).toBe(false);
  });

  it('rejects proficiencyBonus out of range', () => {
    expect(dnd5eSheetSchema.safeParse({ proficiencyBonus: 7 }).success).toBe(false);
  });

  it('rejects an inventory item name over 60 chars', () => {
    expect(
      dnd5eSheetSchema.safeParse({ inventory: [{ name: 'x'.repeat(61) }] }).success,
    ).toBe(false);
  });

  it('rejects deathSaves above 3', () => {
    expect(
      dnd5eSheetSchema.safeParse({ deathSaves: { successes: 4 } }).success,
    ).toBe(false);
  });

  it('rejects notes over 8000 chars', () => {
    expect(dnd5eSheetSchema.safeParse({ notes: 'x'.repeat(8001) }).success).toBe(false);
  });
});

describe('genericSheetSchema', () => {
  it('fills defaults for empty input', () => {
    const parsed = genericSheetSchema.parse({});
    expect(parsed.pronouns).toBe('');
    expect(parsed.description).toBe('');
    expect(parsed.stats).toEqual([]);
    expect(parsed.notes).toBe('');
  });

  it('accepts populated stats', () => {
    const result = genericSheetSchema.safeParse({
      pronouns: 'they/them',
      description: 'A wanderer',
      stats: [{ label: 'Luck', value: '7' }],
      notes: 'misc',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a stat label over 40 chars', () => {
    expect(
      genericSheetSchema.safeParse({ stats: [{ label: 'x'.repeat(41), value: '1' }] })
        .success,
    ).toBe(false);
  });

  it('rejects a missing stat value', () => {
    expect(genericSheetSchema.safeParse({ stats: [{ label: 'HP' }] }).success).toBe(false);
  });
});

describe('pbtaSheetSchema', () => {
  it('fills defaults for empty input', () => {
    const parsed = pbtaSheetSchema.parse({});
    expect(parsed.playbook).toBe('');
    expect(parsed.hx).toEqual([]);
    expect(parsed.stats).toEqual({ cool: 0, hard: 0, hot: 0, sharp: 0, weird: 0 });
    expect(parsed.moves).toEqual([]);
    expect(parsed.notes).toBe('');
  });

  it('accepts a populated sheet', () => {
    const result = pbtaSheetSchema.safeParse({
      playbook: 'The Angel',
      hx: [{ name: 'Doc', value: 2 }],
      stats: { cool: 1, hard: -1, hot: 2, sharp: 0, weird: -2 },
      moves: [{ name: 'Sixth Sense', description: 'You can feel danger.' }],
      notes: 'careful',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a stat above 3', () => {
    expect(pbtaSheetSchema.safeParse({ stats: { cool: 4 } }).success).toBe(false);
  });

  it('rejects an hx value below -3', () => {
    expect(
      pbtaSheetSchema.safeParse({ hx: [{ name: 'X', value: -4 }] }).success,
    ).toBe(false);
  });
});

describe('characterSchema', () => {
  const base = {
    id: ULID,
    campaignId: ULID2,
    ownerUserId: ULID,
    name: 'Mara',
    conceptOneLiner: 'A grizzled veteran',
    system: 'dnd5e' as const,
    sheetJson: { anything: true },
    portraitAttachmentId: ULID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('accepts a well-formed character', () => {
    expect(characterSchema.safeParse(base).success).toBe(true);
  });

  it('accepts null conceptOneLiner and null portraitAttachmentId', () => {
    expect(
      characterSchema.safeParse({ ...base, conceptOneLiner: null, portraitAttachmentId: null })
        .success,
    ).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(characterSchema.safeParse({ ...base, name: '' }).success).toBe(false);
  });

  it('rejects a name over 80 chars', () => {
    expect(characterSchema.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('rejects a bad id', () => {
    expect(characterSchema.safeParse({ ...base, id: 'not-a-ulid' }).success).toBe(false);
  });

  it('rejects a non-datetime createdAt', () => {
    expect(characterSchema.safeParse({ ...base, createdAt: 'yesterday' }).success).toBe(false);
  });
});

describe('createCharacterRequestSchema', () => {
  it('defaults system to dnd5e when omitted', () => {
    const parsed = createCharacterRequestSchema.parse({ name: 'Briar' });
    expect(parsed.system).toBe('dnd5e');
  });

  it('accepts optional conceptOneLiner and portraitAttachmentId', () => {
    const result = createCharacterRequestSchema.safeParse({
      name: 'Briar',
      conceptOneLiner: 'hedge witch',
      system: 'pbta',
      portraitAttachmentId: ULID,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing name', () => {
    expect(createCharacterRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects conceptOneLiner over 200 chars', () => {
    expect(
      createCharacterRequestSchema.safeParse({ name: 'X', conceptOneLiner: 'x'.repeat(201) })
        .success,
    ).toBe(false);
  });
});

describe('updateCharacterRequestSchema', () => {
  it('accepts an empty update', () => {
    expect(updateCharacterRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts nullable conceptOneLiner and portraitAttachmentId', () => {
    expect(
      updateCharacterRequestSchema.safeParse({
        conceptOneLiner: null,
        portraitAttachmentId: null,
        sheetJson: { foo: 'bar' },
      }).success,
    ).toBe(true);
  });

  it('rejects an empty name when provided', () => {
    expect(updateCharacterRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('validateSheetForSystem', () => {
  it('parses dnd5e with defaults from null', () => {
    const sheet = validateSheetForSystem('dnd5e', null) as { level: number };
    expect(sheet.level).toBe(1);
  });

  it('parses pbta with defaults from undefined', () => {
    const sheet = validateSheetForSystem('pbta', undefined) as { playbook: string };
    expect(sheet.playbook).toBe('');
  });

  it('parses generic and fills defaults', () => {
    const sheet = validateSheetForSystem('generic', {}) as { pronouns: string };
    expect(sheet.pronouns).toBe('');
  });

  it('falls through to generic for an unknown system', () => {
    const sheet = validateSheetForSystem('homebrew' as never, {}) as { stats: unknown[] };
    expect(sheet.stats).toEqual([]);
  });

  it('throws on an invalid dnd5e sheet', () => {
    expect(() => validateSheetForSystem('dnd5e', { level: 99 })).toThrow();
  });
});

describe('characterMacroSchema', () => {
  const base = {
    id: ULID,
    characterId: ULID2,
    label: 'Fireball',
    notation: '8d6',
    modifierJson: { adv: false },
    position: 0,
    color: '#ff0000',
  };

  it('accepts a valid macro', () => {
    expect(characterMacroSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a null color', () => {
    expect(characterMacroSchema.safeParse({ ...base, color: null }).success).toBe(true);
  });

  it('rejects an empty label', () => {
    expect(characterMacroSchema.safeParse({ ...base, label: '' }).success).toBe(false);
  });

  it('rejects a negative position', () => {
    expect(characterMacroSchema.safeParse({ ...base, position: -1 }).success).toBe(false);
  });

  it('rejects a color over 7 chars', () => {
    expect(characterMacroSchema.safeParse({ ...base, color: '#abcdef0' }).success).toBe(false);
  });
});

describe('createMacroRequestSchema', () => {
  it('accepts minimal required fields', () => {
    expect(
      createMacroRequestSchema.safeParse({ label: 'Stab', notation: '1d4+2' }).success,
    ).toBe(true);
  });

  it('accepts optional modifierJson and color', () => {
    expect(
      createMacroRequestSchema.safeParse({
        label: 'Stab',
        notation: '1d4+2',
        modifierJson: {},
        color: '#000',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing notation', () => {
    expect(createMacroRequestSchema.safeParse({ label: 'Stab' }).success).toBe(false);
  });

  it('rejects a notation over 200 chars', () => {
    expect(
      createMacroRequestSchema.safeParse({ label: 'X', notation: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('updateMacroRequestSchema', () => {
  it('accepts an empty (all-partial) update', () => {
    expect(updateMacroRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a single-field update', () => {
    expect(updateMacroRequestSchema.safeParse({ label: 'Renamed' }).success).toBe(true);
  });

  it('rejects an empty label when present', () => {
    expect(updateMacroRequestSchema.safeParse({ label: '' }).success).toBe(false);
  });
});
