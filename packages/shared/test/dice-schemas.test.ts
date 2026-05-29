import { describe, expect, it } from 'vitest';
import {
  diceRollResultSchema,
  diceRollSchema,
  diceTermResultSchema,
  diceVisibilitySchema,
  dieResultSchema,
  rollDiceRequestSchema,
} from '../src/schemas/dice.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('diceVisibilitySchema', () => {
  it.each(['public', 'gm_only', 'private'])('accepts %s', (v) => {
    expect(diceVisibilitySchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown visibility', () => {
    expect(diceVisibilitySchema.safeParse('secret').success).toBe(false);
  });
});

describe('dieResultSchema', () => {
  it('accepts a kept die', () => {
    expect(dieResultSchema.safeParse({ value: 6, kept: true }).success).toBe(true);
  });

  it('accepts a zero value', () => {
    expect(dieResultSchema.safeParse({ value: 0, kept: false }).success).toBe(true);
  });

  it('rejects a negative value', () => {
    expect(dieResultSchema.safeParse({ value: -1, kept: true }).success).toBe(false);
  });

  it('rejects a non-integer value', () => {
    expect(dieResultSchema.safeParse({ value: 3.5, kept: true }).success).toBe(false);
  });

  it('rejects a missing kept flag', () => {
    expect(dieResultSchema.safeParse({ value: 3 }).success).toBe(false);
  });
});

describe('diceTermResultSchema (discriminated union)', () => {
  it('accepts a dice term with keep null', () => {
    expect(
      diceTermResultSchema.safeParse({
        kind: 'dice',
        count: 2,
        faces: 6,
        keep: null,
        rolls: [
          { value: 3, kept: true },
          { value: 5, kept: true },
        ],
        sign: 1,
        subtotal: 8,
      }).success,
    ).toBe(true);
  });

  it('accepts a dice term with a keep-highest spec', () => {
    expect(
      diceTermResultSchema.safeParse({
        kind: 'dice',
        count: 4,
        faces: 6,
        keep: { mode: 'kh', amount: 3 },
        rolls: [
          { value: 1, kept: false },
          { value: 6, kept: true },
          { value: 4, kept: true },
          { value: 5, kept: true },
        ],
        sign: -1,
        subtotal: 15,
      }).success,
    ).toBe(true);
  });

  it('accepts a modifier term', () => {
    expect(
      diceTermResultSchema.safeParse({ kind: 'modifier', value: 5, sign: 1, subtotal: 5 })
        .success,
    ).toBe(true);
  });

  it('accepts a negative-sign modifier term', () => {
    expect(
      diceTermResultSchema.safeParse({ kind: 'modifier', value: 2, sign: -1, subtotal: -2 })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown discriminator kind', () => {
    expect(diceTermResultSchema.safeParse({ kind: 'roll', value: 1 }).success).toBe(false);
  });

  it('rejects a dice term with non-positive count', () => {
    expect(
      diceTermResultSchema.safeParse({
        kind: 'dice',
        count: 0,
        faces: 6,
        keep: null,
        rolls: [],
        sign: 1,
        subtotal: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a keep mode that is not kh/kl', () => {
    expect(
      diceTermResultSchema.safeParse({
        kind: 'dice',
        count: 2,
        faces: 6,
        keep: { mode: 'dl', amount: 1 },
        rolls: [],
        sign: 1,
        subtotal: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a sign that is not 1 or -1', () => {
    expect(
      diceTermResultSchema.safeParse({ kind: 'modifier', value: 1, sign: 2, subtotal: 1 })
        .success,
    ).toBe(false);
  });
});

describe('diceRollResultSchema', () => {
  it('accepts a result with mixed terms', () => {
    expect(
      diceRollResultSchema.safeParse({
        notation: '2d6+1',
        terms: [
          {
            kind: 'dice',
            count: 2,
            faces: 6,
            keep: null,
            rolls: [
              { value: 3, kept: true },
              { value: 4, kept: true },
            ],
            sign: 1,
            subtotal: 7,
          },
          { kind: 'modifier', value: 1, sign: 1, subtotal: 1 },
        ],
        total: 8,
      }).success,
    ).toBe(true);
  });

  it('accepts an empty terms array', () => {
    expect(diceRollResultSchema.safeParse({ notation: '', terms: [], total: 0 }).success).toBe(
      true,
    );
  });

  it('rejects a notation over the max length', () => {
    expect(
      diceRollResultSchema.safeParse({ notation: 'x'.repeat(129), terms: [], total: 0 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer total', () => {
    expect(
      diceRollResultSchema.safeParse({ notation: '1d6', terms: [], total: 1.5 }).success,
    ).toBe(false);
  });
});

describe('diceRollSchema', () => {
  const result = {
    notation: '1d20',
    terms: [
      {
        kind: 'dice' as const,
        count: 1,
        faces: 20,
        keep: null,
        rolls: [{ value: 17, kept: true }],
        sign: 1 as const,
        subtotal: 17,
      },
    ],
    total: 17,
  };
  const base = {
    id: ULID,
    serverId: ULID2,
    channelId: ULID,
    dmChannelId: null,
    messageId: ULID2,
    userId: ULID,
    notation: '1d20',
    label: 'Perception',
    result,
    total: 17,
    visibility: 'public' as const,
    createdAt: new Date().toISOString(),
  };

  it('accepts a server roll', () => {
    expect(diceRollSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a DM roll with server/channel null', () => {
    expect(
      diceRollSchema.safeParse({
        ...base,
        serverId: null,
        channelId: null,
        dmChannelId: ULID,
        messageId: null,
        label: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a label over 120 chars', () => {
    expect(diceRollSchema.safeParse({ ...base, label: 'x'.repeat(121) }).success).toBe(false);
  });

  it('rejects an invalid visibility', () => {
    expect(diceRollSchema.safeParse({ ...base, visibility: 'hidden' }).success).toBe(false);
  });

  it('rejects a malformed nested result', () => {
    expect(
      diceRollSchema.safeParse({ ...base, result: { notation: '1d6', terms: [{}], total: 0 } })
        .success,
    ).toBe(false);
  });
});

describe('rollDiceRequestSchema (refinement: exactly one target)', () => {
  it('defaults visibility to public', () => {
    const parsed = rollDiceRequestSchema.parse({ channelId: ULID, notation: '1d20' });
    expect(parsed.visibility).toBe('public');
  });

  it('accepts a channelId-only request', () => {
    expect(
      rollDiceRequestSchema.safeParse({ channelId: ULID, notation: '1d20' }).success,
    ).toBe(true);
  });

  it('accepts a dmChannelId-only request', () => {
    expect(
      rollDiceRequestSchema.safeParse({ dmChannelId: ULID, notation: '1d20' }).success,
    ).toBe(true);
  });

  it('rejects when both channelId and dmChannelId are present', () => {
    expect(
      rollDiceRequestSchema.safeParse({ channelId: ULID, dmChannelId: ULID2, notation: '1d6' })
        .success,
    ).toBe(false);
  });

  it('rejects when neither target is present', () => {
    expect(rollDiceRequestSchema.safeParse({ notation: '1d6' }).success).toBe(false);
  });

  it('rejects an empty notation', () => {
    expect(rollDiceRequestSchema.safeParse({ channelId: ULID, notation: '' }).success).toBe(
      false,
    );
  });

  it('rejects a notation over the max length', () => {
    expect(
      rollDiceRequestSchema.safeParse({ channelId: ULID, notation: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('accepts an explicit visibility', () => {
    expect(
      rollDiceRequestSchema.safeParse({
        dmChannelId: ULID,
        notation: '2d6',
        label: 'Attack',
        visibility: 'gm_only',
      }).success,
    ).toBe(true);
  });
});
