import { describe, expect, it } from 'vitest';
import {
  campaignSchema,
  campaignStatusSchema,
  createCampaignRequestSchema,
  safetyBoundaryActionSchema,
  safetyBoundarySchema,
  updateCampaignRequestSchema,
} from '../src/schemas/campaigns.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('campaignStatusSchema', () => {
  it.each(['planning', 'active', 'paused', 'completed', 'archived'])(
    'accepts %s',
    (v) => {
      expect(campaignStatusSchema.safeParse(v).success).toBe(true);
    },
  );

  it('rejects an unknown status', () => {
    expect(campaignStatusSchema.safeParse('on_hold').success).toBe(false);
  });
});

describe('safetyBoundaryActionSchema', () => {
  it.each(['allow', 'fade_to_black', 'content_warning', 'requires_consent', 'block'])(
    'accepts %s',
    (v) => {
      expect(safetyBoundaryActionSchema.safeParse(v).success).toBe(true);
    },
  );

  it('rejects an unknown action', () => {
    expect(safetyBoundaryActionSchema.safeParse('warn').success).toBe(false);
  });
});

describe('safetyBoundarySchema', () => {
  it('accepts a boundary with a note', () => {
    expect(
      safetyBoundarySchema.safeParse({
        topic: 'gore',
        action: 'fade_to_black',
        note: 'keep it tasteful',
      }).success,
    ).toBe(true);
  });

  it('accepts a boundary without a note (optional)', () => {
    expect(
      safetyBoundarySchema.safeParse({ topic: 'spiders', action: 'block' }).success,
    ).toBe(true);
  });

  it('rejects an empty topic', () => {
    expect(safetyBoundarySchema.safeParse({ topic: '', action: 'allow' }).success).toBe(false);
  });

  it('rejects a topic over 64 chars', () => {
    expect(
      safetyBoundarySchema.safeParse({ topic: 'x'.repeat(65), action: 'allow' }).success,
    ).toBe(false);
  });

  it('rejects a note over 500 chars', () => {
    expect(
      safetyBoundarySchema.safeParse({ topic: 'x', action: 'allow', note: 'x'.repeat(501) })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid action', () => {
    expect(safetyBoundarySchema.safeParse({ topic: 'x', action: 'nope' }).success).toBe(false);
  });
});

describe('campaignSchema', () => {
  const base = {
    id: ULID,
    serverId: ULID2,
    name: 'Curse of Strahd',
    description: 'A gothic horror campaign',
    gameSystem: 'D&D 5e',
    status: 'active' as const,
    gmUserId: ULID,
    defaultChannelId: ULID2,
    rulesJson: { milestones: true },
    safetyBoundaries: [{ topic: 'gore', action: 'content_warning' as const }],
    createdAt: new Date().toISOString(),
  };

  it('accepts a well-formed campaign', () => {
    expect(campaignSchema.safeParse(base).success).toBe(true);
  });

  it('accepts null description, gameSystem and defaultChannelId', () => {
    expect(
      campaignSchema.safeParse({
        ...base,
        description: null,
        gameSystem: null,
        defaultChannelId: null,
      }).success,
    ).toBe(true);
  });

  it('accepts an empty safetyBoundaries array', () => {
    expect(campaignSchema.safeParse({ ...base, safetyBoundaries: [] }).success).toBe(true);
  });

  it('rejects a name shorter than 2 chars', () => {
    expect(campaignSchema.safeParse({ ...base, name: 'a' }).success).toBe(false);
  });

  it('rejects a name over 64 chars', () => {
    expect(campaignSchema.safeParse({ ...base, name: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects a bad gmUserId', () => {
    expect(campaignSchema.safeParse({ ...base, gmUserId: 'nope' }).success).toBe(false);
  });

  it('rejects a missing status', () => {
    const { status, ...rest } = base;
    void status;
    expect(campaignSchema.safeParse(rest).success).toBe(false);
  });
});

describe('createCampaignRequestSchema', () => {
  it('accepts only a name', () => {
    expect(createCampaignRequestSchema.safeParse({ name: 'New Saga' }).success).toBe(true);
  });

  it('accepts all optional fields', () => {
    expect(
      createCampaignRequestSchema.safeParse({
        name: 'New Saga',
        description: 'epic',
        gameSystem: 'PbtA',
        defaultChannelId: ULID,
        safetyBoundaries: [{ topic: 'x', action: 'allow' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a missing name', () => {
    expect(createCampaignRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a too-short name', () => {
    expect(createCampaignRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
});

describe('updateCampaignRequestSchema', () => {
  it('accepts an empty update', () => {
    expect(updateCampaignRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a status-only update', () => {
    expect(updateCampaignRequestSchema.safeParse({ status: 'paused' }).success).toBe(true);
  });

  it('accepts name + status together', () => {
    expect(
      updateCampaignRequestSchema.safeParse({ name: 'Renamed', status: 'completed' }).success,
    ).toBe(true);
  });

  it('rejects an invalid status', () => {
    expect(updateCampaignRequestSchema.safeParse({ status: 'frozen' }).success).toBe(false);
  });

  it('rejects a too-short name', () => {
    expect(updateCampaignRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
});
