import { describe, expect, it } from 'vitest';
import {
  createHandoutRequestSchema,
  handoutSchema,
  handoutVisibilitySchema,
  updateHandoutRequestSchema,
} from '../src/schemas/handouts.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
const NOW = '2026-01-01T00:00:00.000Z';

describe('handoutVisibilitySchema', () => {
  it.each(['public_to_party', 'gm_only', 'specific_players'])('accepts %s', (value) => {
    expect(handoutVisibilitySchema.safeParse(value).success).toBe(true);
  });

  it('rejects an unknown visibility', () => {
    expect(handoutVisibilitySchema.safeParse('nobody').success).toBe(false);
  });
});

describe('handoutSchema', () => {
  const valid = {
    id: ULID,
    campaignId: ULID2,
    serverId: ULID,
    authorId: ULID2,
    title: 'The ancient map',
    body: 'A weathered parchment.',
    attachmentIds: [ULID, ULID2],
    visibility: 'specific_players',
    visibleToUserIds: [ULID],
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts a well-formed handout', () => {
    expect(handoutSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts empty attachment and visibility lists', () => {
    const result = handoutSchema.safeParse({
      ...valid,
      attachmentIds: [],
      visibleToUserIds: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(handoutSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
  });

  it('rejects a title longer than 64 chars (MAX_SERVER_NAME)', () => {
    expect(handoutSchema.safeParse({ ...valid, title: 'a'.repeat(65) }).success).toBe(false);
  });

  it('rejects a non-ULID in attachmentIds', () => {
    expect(handoutSchema.safeParse({ ...valid, attachmentIds: ['bad'] }).success).toBe(false);
  });

  it('rejects a non-ULID in visibleToUserIds', () => {
    expect(handoutSchema.safeParse({ ...valid, visibleToUserIds: ['bad'] }).success).toBe(false);
  });

  it('rejects an invalid visibility', () => {
    expect(handoutSchema.safeParse({ ...valid, visibility: 'nope' }).success).toBe(false);
  });

  it('rejects a missing serverId', () => {
    const { serverId: _omit, ...rest } = valid;
    expect(handoutSchema.safeParse(rest).success).toBe(false);
  });
});

describe('createHandoutRequestSchema', () => {
  it('accepts a minimal request and applies defaults for body/visibility', () => {
    const result = createHandoutRequestSchema.parse({
      campaignId: ULID,
      title: 'A note',
    });
    expect(result.body).toBe('');
    expect(result.visibility).toBe('public_to_party');
  });

  it('accepts explicit attachments, visibility, and visibleToUserIds', () => {
    const result = createHandoutRequestSchema.parse({
      campaignId: ULID,
      title: 'Secret dossier',
      body: 'For the rogue only.',
      attachmentIds: [ULID],
      visibility: 'specific_players',
      visibleToUserIds: [ULID2],
    });
    expect(result.body).toBe('For the rogue only.');
    expect(result.visibility).toBe('specific_players');
    expect(result.attachmentIds).toEqual([ULID]);
    expect(result.visibleToUserIds).toEqual([ULID2]);
  });

  it('rejects a body longer than 50,000 chars', () => {
    const result = createHandoutRequestSchema.safeParse({
      campaignId: ULID,
      title: 'x',
      body: 'a'.repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(createHandoutRequestSchema.safeParse({ campaignId: ULID, title: '' }).success).toBe(
      false,
    );
  });

  it('rejects a missing campaignId', () => {
    expect(createHandoutRequestSchema.safeParse({ title: 'x' }).success).toBe(false);
  });

  it('rejects a non-ULID attachmentId', () => {
    const result = createHandoutRequestSchema.safeParse({
      campaignId: ULID,
      title: 'x',
      attachmentIds: ['bad'],
    });
    expect(result.success).toBe(false);
  });
});

describe('updateHandoutRequestSchema', () => {
  it('accepts an empty object (all optional via partial)', () => {
    expect(updateHandoutRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a visibility-only update', () => {
    expect(updateHandoutRequestSchema.safeParse({ visibility: 'gm_only' }).success).toBe(true);
  });

  it('strips campaignId (omitted from the base before partial)', () => {
    const result = updateHandoutRequestSchema.parse({ campaignId: ULID, title: 'x' });
    expect(result).not.toHaveProperty('campaignId');
    expect(result.title).toBe('x');
  });

  it('rejects an invalid visibility when provided', () => {
    expect(updateHandoutRequestSchema.safeParse({ visibility: 'nope' }).success).toBe(false);
  });
});
