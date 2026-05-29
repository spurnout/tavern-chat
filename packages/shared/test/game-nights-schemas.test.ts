import { describe, expect, it } from 'vitest';
import {
  createGameNightRequestSchema,
  gameNightCandidateSchema,
  gameNightRsvpRequestSchema,
  gameNightSchema,
  gameNightStatusSchema,
  proposeGameRequestSchema,
  updateGameNightRequestSchema,
  voteForGameRequestSchema,
} from '../src/schemas/game-nights.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('gameNightStatusSchema', () => {
  it.each(['planning', 'scheduled', 'live', 'completed', 'cancelled'])('accepts %s', (v) => {
    expect(gameNightStatusSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(gameNightStatusSchema.safeParse('postponed').success).toBe(false);
  });
});

describe('gameNightCandidateSchema', () => {
  const base = {
    gameNightId: ULID,
    boardGameId: ULID2,
    proposedById: ULID,
    voteCount: 3,
    meVoted: true,
  };

  it('accepts a valid candidate', () => {
    expect(gameNightCandidateSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a zero vote count', () => {
    expect(gameNightCandidateSchema.safeParse({ ...base, voteCount: 0 }).success).toBe(true);
  });

  it('rejects a negative vote count', () => {
    expect(gameNightCandidateSchema.safeParse({ ...base, voteCount: -1 }).success).toBe(false);
  });

  it('rejects a non-boolean meVoted', () => {
    expect(gameNightCandidateSchema.safeParse({ ...base, meVoted: 'yes' }).success).toBe(false);
  });
});

describe('gameNightSchema', () => {
  const base = {
    id: ULID,
    serverId: ULID2,
    title: 'Friday Night Games',
    description: 'Bring snacks',
    scheduledStart: new Date().toISOString(),
    scheduledEnd: new Date().toISOString(),
    location: 'The Den',
    voiceChannelId: ULID,
    textChannelId: ULID2,
    status: 'scheduled' as const,
    selectedBoardGameId: ULID,
    createdById: ULID2,
    createdAt: new Date().toISOString(),
  };

  it('accepts a well-formed game night', () => {
    expect(gameNightSchema.safeParse(base).success).toBe(true);
  });

  it('accepts nulls for the nullable fields', () => {
    expect(
      gameNightSchema.safeParse({
        ...base,
        description: null,
        scheduledStart: null,
        scheduledEnd: null,
        location: null,
        voiceChannelId: null,
        textChannelId: null,
        selectedBoardGameId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(gameNightSchema.safeParse({ ...base, title: '' }).success).toBe(false);
  });

  it('rejects a location over 120 chars', () => {
    expect(gameNightSchema.safeParse({ ...base, location: 'x'.repeat(121) }).success).toBe(
      false,
    );
  });

  it('rejects a non-datetime scheduledStart', () => {
    expect(gameNightSchema.safeParse({ ...base, scheduledStart: 'soon' }).success).toBe(false);
  });
});

describe('createGameNightRequestSchema', () => {
  it('accepts only a title', () => {
    expect(createGameNightRequestSchema.safeParse({ title: 'Game Day' }).success).toBe(true);
  });

  it('accepts all optional fields including candidates', () => {
    expect(
      createGameNightRequestSchema.safeParse({
        title: 'Game Day',
        description: 'fun',
        scheduledStart: new Date().toISOString(),
        scheduledEnd: new Date().toISOString(),
        location: 'home',
        voiceChannelId: ULID,
        textChannelId: ULID2,
        candidateBoardGameIds: [ULID, ULID2],
      }).success,
    ).toBe(true);
  });

  it('rejects a missing title', () => {
    expect(createGameNightRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a bad id in candidateBoardGameIds', () => {
    expect(
      createGameNightRequestSchema.safeParse({ title: 'X', candidateBoardGameIds: ['bad'] })
        .success,
    ).toBe(false);
  });
});

describe('updateGameNightRequestSchema', () => {
  it('accepts an empty update', () => {
    expect(updateGameNightRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a status + selectedBoardGameId update', () => {
    expect(
      updateGameNightRequestSchema.safeParse({ status: 'live', selectedBoardGameId: ULID })
        .success,
    ).toBe(true);
  });

  it('accepts a null selectedBoardGameId', () => {
    expect(
      updateGameNightRequestSchema.safeParse({ selectedBoardGameId: null }).success,
    ).toBe(true);
  });

  it('rejects an invalid status', () => {
    expect(updateGameNightRequestSchema.safeParse({ status: 'maybe' }).success).toBe(false);
  });
});

describe('proposeGameRequestSchema / voteForGameRequestSchema', () => {
  it('proposeGameRequestSchema accepts a boardGameId', () => {
    expect(proposeGameRequestSchema.safeParse({ boardGameId: ULID }).success).toBe(true);
  });

  it('proposeGameRequestSchema rejects a missing boardGameId', () => {
    expect(proposeGameRequestSchema.safeParse({}).success).toBe(false);
  });

  it('voteForGameRequestSchema accepts a boardGameId', () => {
    expect(voteForGameRequestSchema.safeParse({ boardGameId: ULID2 }).success).toBe(true);
  });

  it('voteForGameRequestSchema rejects a bad boardGameId', () => {
    expect(voteForGameRequestSchema.safeParse({ boardGameId: 'nope' }).success).toBe(false);
  });
});

describe('gameNightRsvpRequestSchema', () => {
  it.each(['yes', 'no', 'maybe', 'late'])('accepts status %s', (status) => {
    expect(gameNightRsvpRequestSchema.safeParse({ status }).success).toBe(true);
  });

  it('rejects an invalid rsvp status', () => {
    expect(gameNightRsvpRequestSchema.safeParse({ status: 'perhaps' }).success).toBe(false);
  });

  it('rejects a missing status', () => {
    expect(gameNightRsvpRequestSchema.safeParse({}).success).toBe(false);
  });
});
