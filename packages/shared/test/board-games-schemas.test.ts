import { describe, expect, it } from 'vitest';
import {
  boardGameSchema,
  createBoardGameRequestSchema,
  filterBoardGamesQuerySchema,
  updateBoardGameRequestSchema,
} from '../src/schemas/board-games.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('boardGameSchema', () => {
  const base = {
    id: ULID,
    serverId: ULID2,
    name: 'Catan',
    description: 'Trade and build',
    minPlayers: 3,
    maxPlayers: 4,
    playTimeMinutes: 90,
    complexity: 2.3,
    ownerUserId: ULID,
    coverAttachmentId: ULID2,
    tags: ['strategy', 'classic'],
    createdAt: new Date().toISOString(),
  };

  it('accepts a well-formed board game', () => {
    expect(boardGameSchema.safeParse(base).success).toBe(true);
  });

  it('accepts nulls for the nullable fields', () => {
    expect(
      boardGameSchema.safeParse({
        ...base,
        description: null,
        playTimeMinutes: null,
        complexity: null,
        ownerUserId: null,
        coverAttachmentId: null,
      }).success,
    ).toBe(true);
  });

  it('accepts an empty tags array', () => {
    expect(boardGameSchema.safeParse({ ...base, tags: [] }).success).toBe(true);
  });

  it('rejects a non-positive minPlayers', () => {
    expect(boardGameSchema.safeParse({ ...base, minPlayers: 0 }).success).toBe(false);
  });

  it('rejects a non-integer minPlayers', () => {
    expect(boardGameSchema.safeParse({ ...base, minPlayers: 2.5 }).success).toBe(false);
  });

  it('rejects complexity above 5', () => {
    expect(boardGameSchema.safeParse({ ...base, complexity: 5.5 }).success).toBe(false);
  });

  it('rejects complexity below 1', () => {
    expect(boardGameSchema.safeParse({ ...base, complexity: 0.5 }).success).toBe(false);
  });

  it('rejects an empty tag string', () => {
    expect(boardGameSchema.safeParse({ ...base, tags: [''] }).success).toBe(false);
  });

  it('rejects a tag over 32 chars', () => {
    expect(boardGameSchema.safeParse({ ...base, tags: ['x'.repeat(33)] }).success).toBe(false);
  });

  it('rejects a name over the server-name limit', () => {
    expect(boardGameSchema.safeParse({ ...base, name: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('createBoardGameRequestSchema', () => {
  it('accepts minimal required fields', () => {
    expect(
      createBoardGameRequestSchema.safeParse({ name: 'Uno', minPlayers: 2, maxPlayers: 10 })
        .success,
    ).toBe(true);
  });

  it('accepts all optional fields', () => {
    expect(
      createBoardGameRequestSchema.safeParse({
        name: 'Uno',
        description: 'card game',
        minPlayers: 2,
        maxPlayers: 10,
        playTimeMinutes: 30,
        complexity: 1,
        ownerUserId: ULID,
        coverAttachmentId: ULID2,
        tags: ['cards'],
      }).success,
    ).toBe(true);
  });

  it('rejects a missing minPlayers', () => {
    expect(createBoardGameRequestSchema.safeParse({ name: 'Uno', maxPlayers: 4 }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive maxPlayers', () => {
    expect(
      createBoardGameRequestSchema.safeParse({ name: 'Uno', minPlayers: 2, maxPlayers: 0 })
        .success,
    ).toBe(false);
  });
});

describe('updateBoardGameRequestSchema', () => {
  it('accepts an empty (all-partial) update', () => {
    expect(updateBoardGameRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a single-field update', () => {
    expect(updateBoardGameRequestSchema.safeParse({ maxPlayers: 6 }).success).toBe(true);
  });

  it('rejects an invalid field value', () => {
    expect(updateBoardGameRequestSchema.safeParse({ complexity: 9 }).success).toBe(false);
  });
});

describe('filterBoardGamesQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(filterBoardGamesQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces numeric string params to numbers', () => {
    const parsed = filterBoardGamesQuerySchema.parse({
      players: '4',
      maxPlayTimeMinutes: '120',
      maxComplexity: '3.5',
    });
    expect(parsed.players).toBe(4);
    expect(parsed.maxPlayTimeMinutes).toBe(120);
    expect(parsed.maxComplexity).toBe(3.5);
  });

  it('accepts tag and search strings', () => {
    const result = filterBoardGamesQuerySchema.safeParse({ tag: 'coop', search: 'pandemic' });
    expect(result.success).toBe(true);
  });

  it('rejects players coercing to a non-positive number', () => {
    expect(filterBoardGamesQuerySchema.safeParse({ players: '0' }).success).toBe(false);
  });

  it('rejects maxComplexity coercing above 5', () => {
    expect(filterBoardGamesQuerySchema.safeParse({ maxComplexity: '6' }).success).toBe(false);
  });

  it('rejects a non-numeric players value', () => {
    expect(filterBoardGamesQuerySchema.safeParse({ players: 'lots' }).success).toBe(false);
  });

  it('rejects a search string over 64 chars', () => {
    expect(filterBoardGamesQuerySchema.safeParse({ search: 'x'.repeat(65) }).success).toBe(
      false,
    );
  });
});
