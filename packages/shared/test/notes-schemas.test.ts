import { describe, expect, it } from 'vitest';
import {
  campaignNoteSchema,
  createNoteRequestSchema,
  noteVisibilitySchema,
  updateNoteRequestSchema,
} from '../src/schemas/notes.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
const NOW = '2026-01-01T00:00:00.000Z';

describe('noteVisibilitySchema', () => {
  it.each(['public_to_party', 'gm_only'])('accepts %s', (value) => {
    expect(noteVisibilitySchema.safeParse(value).success).toBe(true);
  });

  it('rejects an unknown visibility', () => {
    expect(noteVisibilitySchema.safeParse('everyone').success).toBe(false);
  });
});

describe('campaignNoteSchema', () => {
  const valid = {
    id: ULID,
    campaignId: ULID2,
    serverId: ULID,
    authorId: ULID2,
    title: 'Session 1 recap',
    body: 'The party met at the tavern.',
    visibility: 'public_to_party',
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts a well-formed note', () => {
    expect(campaignNoteSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an empty body', () => {
    expect(campaignNoteSchema.safeParse({ ...valid, body: '' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(campaignNoteSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
  });

  it('rejects a title longer than 120 chars', () => {
    expect(campaignNoteSchema.safeParse({ ...valid, title: 'a'.repeat(121) }).success).toBe(
      false,
    );
  });

  it('rejects an invalid visibility', () => {
    expect(campaignNoteSchema.safeParse({ ...valid, visibility: 'nope' }).success).toBe(false);
  });

  it('rejects a non-boolean pinned', () => {
    expect(campaignNoteSchema.safeParse({ ...valid, pinned: 'yes' }).success).toBe(false);
  });

  it('rejects a missing campaignId', () => {
    const { campaignId: _omit, ...rest } = valid;
    expect(campaignNoteSchema.safeParse(rest).success).toBe(false);
  });
});

describe('createNoteRequestSchema', () => {
  it('accepts a minimal request and applies defaults for body/visibility', () => {
    const result = createNoteRequestSchema.parse({
      campaignId: ULID,
      title: 'Quick note',
    });
    expect(result.body).toBe('');
    expect(result.visibility).toBe('public_to_party');
  });

  it('accepts an explicit body, visibility, and pinned', () => {
    const result = createNoteRequestSchema.parse({
      campaignId: ULID,
      title: 'GM secret',
      body: 'The villain is the innkeeper.',
      visibility: 'gm_only',
      pinned: true,
    });
    expect(result.body).toBe('The villain is the innkeeper.');
    expect(result.visibility).toBe('gm_only');
    expect(result.pinned).toBe(true);
  });

  it('rejects a body longer than 50,000 chars', () => {
    const result = createNoteRequestSchema.safeParse({
      campaignId: ULID,
      title: 'x',
      body: 'a'.repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(createNoteRequestSchema.safeParse({ campaignId: ULID, title: '' }).success).toBe(
      false,
    );
  });

  it('rejects a missing campaignId', () => {
    expect(createNoteRequestSchema.safeParse({ title: 'x' }).success).toBe(false);
  });
});

describe('updateNoteRequestSchema', () => {
  it('accepts an empty object (all optional via partial)', () => {
    expect(updateNoteRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a title-only update', () => {
    expect(updateNoteRequestSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
  });

  it('strips campaignId (omitted from the base before partial)', () => {
    const result = updateNoteRequestSchema.parse({ campaignId: ULID, title: 'x' });
    expect(result).not.toHaveProperty('campaignId');
    expect(result.title).toBe('x');
  });

  it('rejects a title longer than 120 chars when provided', () => {
    expect(updateNoteRequestSchema.safeParse({ title: 'a'.repeat(121) }).success).toBe(false);
  });
});
