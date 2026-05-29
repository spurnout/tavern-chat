import { describe, expect, it } from 'vitest';
import {
  campaignSessionSchema,
  campaignSessionStatusSchema,
  createCampaignSessionRequestSchema,
  liveSessionGmNoteSchema,
  liveSessionPayloadSchema,
  rsvpRequestSchema,
  rsvpSchema,
  rsvpStatusSchema,
  updateCampaignSessionRequestSchema,
} from '../src/schemas/sessions.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('campaignSessionStatusSchema', () => {
  it.each(['planned', 'live', 'completed', 'cancelled'])('accepts %s', (v) => {
    expect(campaignSessionStatusSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(campaignSessionStatusSchema.safeParse('paused').success).toBe(false);
  });
});

describe('rsvpStatusSchema', () => {
  it.each(['yes', 'no', 'maybe', 'late'])('accepts %s', (v) => {
    expect(rsvpStatusSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown rsvp status', () => {
    expect(rsvpStatusSchema.safeParse('tentative').success).toBe(false);
  });
});

describe('campaignSessionSchema', () => {
  const base = {
    id: ULID,
    campaignId: ULID2,
    serverId: ULID,
    title: 'Session 0',
    description: 'Safety tools',
    scheduledStart: new Date().toISOString(),
    scheduledEnd: new Date().toISOString(),
    voiceChannelId: ULID2,
    textChannelId: ULID,
    status: 'planned' as const,
    agenda: 'intro',
    recap: 'went well',
    createdAt: new Date().toISOString(),
  };

  it('accepts a well-formed session', () => {
    expect(campaignSessionSchema.safeParse(base).success).toBe(true);
  });

  it('accepts nulls for the nullable fields', () => {
    expect(
      campaignSessionSchema.safeParse({
        ...base,
        description: null,
        scheduledStart: null,
        scheduledEnd: null,
        voiceChannelId: null,
        textChannelId: null,
        agenda: null,
        recap: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(campaignSessionSchema.safeParse({ ...base, title: '' }).success).toBe(false);
  });

  it('rejects a non-datetime scheduledStart', () => {
    expect(campaignSessionSchema.safeParse({ ...base, scheduledStart: 'noon' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid status', () => {
    expect(campaignSessionSchema.safeParse({ ...base, status: 'archived' }).success).toBe(false);
  });
});

describe('createCampaignSessionRequestSchema', () => {
  it('accepts minimal required fields', () => {
    expect(
      createCampaignSessionRequestSchema.safeParse({ campaignId: ULID, title: 'Kickoff' })
        .success,
    ).toBe(true);
  });

  it('accepts all optional fields', () => {
    expect(
      createCampaignSessionRequestSchema.safeParse({
        campaignId: ULID,
        title: 'Kickoff',
        description: 'desc',
        scheduledStart: new Date().toISOString(),
        scheduledEnd: new Date().toISOString(),
        voiceChannelId: ULID2,
        textChannelId: ULID,
        agenda: 'beats',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing campaignId', () => {
    expect(createCampaignSessionRequestSchema.safeParse({ title: 'Kickoff' }).success).toBe(
      false,
    );
  });

  it('rejects an agenda over 8000 chars', () => {
    expect(
      createCampaignSessionRequestSchema.safeParse({
        campaignId: ULID,
        title: 'X',
        agenda: 'x'.repeat(8001),
      }).success,
    ).toBe(false);
  });
});

describe('updateCampaignSessionRequestSchema', () => {
  it('accepts an empty update', () => {
    expect(updateCampaignSessionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts status + recap together', () => {
    expect(
      updateCampaignSessionRequestSchema.safeParse({ status: 'completed', recap: 'epic finale' })
        .success,
    ).toBe(true);
  });

  it('accepts a title-only update (campaignId omitted from shape)', () => {
    expect(updateCampaignSessionRequestSchema.safeParse({ title: 'Renamed' }).success).toBe(
      true,
    );
  });

  it('rejects a recap over 16000 chars', () => {
    expect(
      updateCampaignSessionRequestSchema.safeParse({ recap: 'x'.repeat(16001) }).success,
    ).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(updateCampaignSessionRequestSchema.safeParse({ status: 'paused' }).success).toBe(
      false,
    );
  });
});

describe('rsvpRequestSchema', () => {
  it('accepts a valid status', () => {
    expect(rsvpRequestSchema.safeParse({ status: 'yes' }).success).toBe(true);
  });

  it('rejects a missing status', () => {
    expect(rsvpRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(rsvpRequestSchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

describe('rsvpSchema', () => {
  const base = {
    sessionId: ULID,
    userId: ULID2,
    status: 'maybe' as const,
    updatedAt: new Date().toISOString(),
  };

  it('accepts a valid rsvp record', () => {
    expect(rsvpSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a non-datetime updatedAt', () => {
    expect(rsvpSchema.safeParse({ ...base, updatedAt: 'recently' }).success).toBe(false);
  });

  it('rejects a bad sessionId', () => {
    expect(rsvpSchema.safeParse({ ...base, sessionId: 'nope' }).success).toBe(false);
  });
});

describe('liveSessionGmNoteSchema', () => {
  const base = {
    id: ULID,
    title: 'Villain motive',
    body: 'He wants the crown.',
    pinned: true,
    updatedAt: new Date().toISOString(),
  };

  it('accepts a valid note', () => {
    expect(liveSessionGmNoteSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a non-boolean pinned', () => {
    expect(liveSessionGmNoteSchema.safeParse({ ...base, pinned: 'yes' }).success).toBe(false);
  });

  it('rejects a missing body', () => {
    const { body, ...rest } = base;
    void body;
    expect(liveSessionGmNoteSchema.safeParse(rest).success).toBe(false);
  });
});

describe('liveSessionPayloadSchema', () => {
  const session = {
    id: ULID,
    campaignId: ULID2,
    serverId: ULID,
    title: 'Live one',
    description: null,
    scheduledStart: null,
    scheduledEnd: null,
    voiceChannelId: null,
    textChannelId: null,
    status: 'live' as const,
    agenda: null,
    recap: null,
    createdAt: new Date().toISOString(),
  };

  it('accepts a payload with notes', () => {
    expect(
      liveSessionPayloadSchema.safeParse({
        session,
        isGm: true,
        gmNotes: [
          {
            id: ULID,
            title: 'note',
            body: 'b',
            pinned: false,
            updatedAt: new Date().toISOString(),
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a payload with an empty notes array', () => {
    expect(
      liveSessionPayloadSchema.safeParse({ session, isGm: false, gmNotes: [] }).success,
    ).toBe(true);
  });

  it('rejects a payload with an invalid nested session', () => {
    expect(
      liveSessionPayloadSchema.safeParse({
        session: { ...session, status: 'bogus' },
        isGm: true,
        gmNotes: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing isGm flag', () => {
    expect(liveSessionPayloadSchema.safeParse({ session, gmNotes: [] }).success).toBe(false);
  });
});
