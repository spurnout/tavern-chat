import { describe, expect, it } from 'vitest';
import {
  auditLogActionSchema,
  auditLogEntrySchema,
  createReportRequestSchema,
  moderationActionSchema,
  moderationStatsSchema,
  reportCategorySchema,
  reportEventSchema,
  reportSchema,
  reportStatusSchema,
  reportTargetTypeSchema,
  resolveReportRequestSchema,
  safetyPolicySchema,
  updateSafetyPolicyRequestSchema,
} from '../src/schemas/moderation.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
const NOW = '2026-01-01T00:00:00.000Z';

describe('moderation enums', () => {
  it.each([
    'message',
    'attachment',
    'profile',
    'emoji',
    'campaign_note',
    'handout',
    'voice_message',
  ])('reportTargetTypeSchema accepts %s', (value) => {
    expect(reportTargetTypeSchema.safeParse(value).success).toBe(true);
  });

  it('reportTargetTypeSchema rejects an unknown target', () => {
    expect(reportTargetTypeSchema.safeParse('server').success).toBe(false);
  });

  it('reportCategorySchema accepts a known category', () => {
    expect(reportCategorySchema.safeParse('spam_or_raid').success).toBe(true);
  });

  it('reportCategorySchema rejects an unknown category', () => {
    expect(reportCategorySchema.safeParse('mild_annoyance').success).toBe(false);
  });

  it.each(['open', 'in_review', 'resolved', 'dismissed', 'escalated'])(
    'reportStatusSchema accepts %s',
    (value) => {
      expect(reportStatusSchema.safeParse(value).success).toBe(true);
    },
  );

  it('reportStatusSchema rejects an unknown status', () => {
    expect(reportStatusSchema.safeParse('pending').success).toBe(false);
  });

  it.each([
    'allow',
    'allow_with_label',
    'content_warning',
    'blur',
    'warn_user',
    'hold_for_review',
    'block',
    'quarantine',
    'lock_account',
    'report_workflow',
  ])('moderationActionSchema accepts %s', (value) => {
    expect(moderationActionSchema.safeParse(value).success).toBe(true);
  });

  it('moderationActionSchema rejects an unknown action', () => {
    expect(moderationActionSchema.safeParse('ban_forever').success).toBe(false);
  });

  it('auditLogActionSchema accepts a known action', () => {
    expect(auditLogActionSchema.safeParse('member.banned').success).toBe(true);
  });

  it('auditLogActionSchema rejects an unknown action', () => {
    expect(auditLogActionSchema.safeParse('member.teleported').success).toBe(false);
  });
});

describe('reportEventSchema', () => {
  it('accepts a well-formed event', () => {
    expect(
      reportEventSchema.safeParse({ at: NOW, kind: 'status_change', message: 'opened' }).success,
    ).toBe(true);
  });

  it('rejects a non-datetime at', () => {
    expect(
      reportEventSchema.safeParse({ at: 'soon', kind: 'k', message: 'm' }).success,
    ).toBe(false);
  });

  it('rejects a missing message', () => {
    expect(reportEventSchema.safeParse({ at: NOW, kind: 'k' }).success).toBe(false);
  });
});

describe('reportSchema', () => {
  const valid = {
    id: ULID,
    serverId: ULID2,
    reporterId: ULID,
    targetType: 'message',
    targetId: ULID2,
    category: 'spam_or_raid',
    notes: 'looks like a raid',
    status: 'open',
    resolvedById: null,
    resolutionNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts a minimal valid report', () => {
    expect(reportSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null serverId', () => {
    expect(reportSchema.safeParse({ ...valid, serverId: null }).success).toBe(true);
  });

  it('accepts all hydrated optional fields plus events', () => {
    const result = reportSchema.safeParse({
      ...valid,
      reporterDisplayName: 'Reporter',
      targetUserId: ULID,
      targetUserDisplayName: 'Target',
      targetPreview: 'a bad message',
      resolvedById: ULID,
      resolutionNotes: 'handled',
      status: 'resolved',
      events: [{ at: NOW, kind: 'resolved', message: 'closed' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts null for nullable hydrated fields', () => {
    const result = reportSchema.safeParse({
      ...valid,
      reporterDisplayName: null,
      targetUserId: null,
      targetUserDisplayName: null,
      targetPreview: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts null notes', () => {
    expect(reportSchema.safeParse({ ...valid, notes: null }).success).toBe(true);
  });

  it('rejects notes longer than 2000 chars', () => {
    expect(reportSchema.safeParse({ ...valid, notes: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('rejects resolutionNotes longer than 4000 chars', () => {
    expect(
      reportSchema.safeParse({ ...valid, resolutionNotes: 'a'.repeat(4001) }).success,
    ).toBe(false);
  });

  it('rejects an invalid targetType', () => {
    expect(reportSchema.safeParse({ ...valid, targetType: 'nope' }).success).toBe(false);
  });

  it('rejects a missing reporterId', () => {
    const { reporterId: _omit, ...rest } = valid;
    expect(reportSchema.safeParse(rest).success).toBe(false);
  });
});

describe('moderationStatsSchema', () => {
  it('accepts a well-formed stats object', () => {
    const result = moderationStatsSchema.safeParse({
      openReports: 3,
      inReview: 1,
      newToday: 0,
      oldestUnreviewedAt: NOW,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null oldestUnreviewedAt', () => {
    const result = moderationStatsSchema.safeParse({
      openReports: 0,
      inReview: 0,
      newToday: 0,
      oldestUnreviewedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer count', () => {
    const result = moderationStatsSchema.safeParse({
      openReports: 1.5,
      inReview: 0,
      newToday: 0,
      oldestUnreviewedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('createReportRequestSchema', () => {
  it('accepts a minimal request', () => {
    const result = createReportRequestSchema.safeParse({
      targetType: 'profile',
      targetId: ULID,
      category: 'doxxing_or_private_information',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional serverId and notes', () => {
    const result = createReportRequestSchema.safeParse({
      targetType: 'message',
      targetId: ULID,
      category: 'fraud_or_scam',
      serverId: ULID2,
      notes: 'context',
    });
    expect(result.success).toBe(true);
  });

  it('rejects notes longer than 2000 chars', () => {
    const result = createReportRequestSchema.safeParse({
      targetType: 'message',
      targetId: ULID,
      category: 'fraud_or_scam',
      notes: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing category', () => {
    const result = createReportRequestSchema.safeParse({
      targetType: 'message',
      targetId: ULID,
    });
    expect(result.success).toBe(false);
  });
});

describe('resolveReportRequestSchema', () => {
  it.each(['resolved', 'dismissed', 'escalated'])('accepts status %s', (status) => {
    expect(resolveReportRequestSchema.safeParse({ status }).success).toBe(true);
  });

  it('accepts an optional action and notes', () => {
    const result = resolveReportRequestSchema.safeParse({
      status: 'resolved',
      action: 'block',
      notes: 'done',
    });
    expect(result.success).toBe(true);
  });

  it('rejects the open status (not allowed on resolve)', () => {
    expect(resolveReportRequestSchema.safeParse({ status: 'open' }).success).toBe(false);
  });

  it('rejects an invalid action', () => {
    expect(
      resolveReportRequestSchema.safeParse({ status: 'resolved', action: 'nope' }).success,
    ).toBe(false);
  });
});

describe('auditLogEntrySchema', () => {
  const valid = {
    id: ULID,
    serverId: ULID2,
    actorId: ULID,
    action: 'role.created',
    targetType: 'role',
    targetId: ULID2,
    metadata: { before: null, after: { name: 'Mod' } },
    createdAt: NOW,
  };

  it('accepts a well-formed entry', () => {
    expect(auditLogEntrySchema.safeParse(valid).success).toBe(true);
  });

  it('accepts null serverId/actorId/targetType/targetId', () => {
    const result = auditLogEntrySchema.safeParse({
      ...valid,
      serverId: null,
      actorId: null,
      targetType: null,
      targetId: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts hydrated actor names', () => {
    const result = auditLogEntrySchema.safeParse({
      ...valid,
      actorDisplayName: 'Admin',
      actorUsername: 'admin',
    });
    expect(result.success).toBe(true);
  });

  it('accepts undefined metadata', () => {
    const { metadata: _omit, ...rest } = valid;
    expect(auditLogEntrySchema.safeParse(rest).success).toBe(true);
  });

  it('rejects a targetType longer than 64 chars', () => {
    expect(auditLogEntrySchema.safeParse({ ...valid, targetType: 'a'.repeat(65) }).success).toBe(
      false,
    );
  });

  it('rejects an invalid action', () => {
    expect(auditLogEntrySchema.safeParse({ ...valid, action: 'nope' }).success).toBe(false);
  });
});

describe('safetyPolicySchema', () => {
  const valid = {
    serverId: ULID,
    sfwOnly: true,
    allowNsfwChannels: false,
    spoilerTagsEnabled: true,
    profanityFilter: 'soft',
    uploadDomainAllowlist: ['example.com'],
    uploadDomainBlocklist: [],
    blockExecutableUploads: true,
    blockArchiveUploads: false,
    stripImageMetadata: true,
    updatedAt: NOW,
  };

  it('accepts a well-formed policy', () => {
    expect(safetyPolicySchema.safeParse(valid).success).toBe(true);
  });

  it.each(['off', 'soft', 'strict'])('accepts profanityFilter %s', (profanityFilter) => {
    expect(safetyPolicySchema.safeParse({ ...valid, profanityFilter }).success).toBe(true);
  });

  it('rejects an invalid profanityFilter', () => {
    expect(safetyPolicySchema.safeParse({ ...valid, profanityFilter: 'medium' }).success).toBe(
      false,
    );
  });

  it('rejects an allowlist entry longer than 128 chars', () => {
    expect(
      safetyPolicySchema.safeParse({ ...valid, uploadDomainAllowlist: ['a'.repeat(129)] })
        .success,
    ).toBe(false);
  });

  it('rejects an empty-string blocklist entry', () => {
    expect(
      safetyPolicySchema.safeParse({ ...valid, uploadDomainBlocklist: [''] }).success,
    ).toBe(false);
  });

  it('rejects a non-boolean sfwOnly', () => {
    expect(safetyPolicySchema.safeParse({ ...valid, sfwOnly: 'yes' }).success).toBe(false);
  });
});

describe('updateSafetyPolicyRequestSchema', () => {
  it('accepts an empty object (all optional)', () => {
    expect(updateSafetyPolicyRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a single-field update', () => {
    expect(updateSafetyPolicyRequestSchema.safeParse({ sfwOnly: false }).success).toBe(true);
  });

  it('does not allow serverId (omitted field is stripped, not validated)', () => {
    const result = updateSafetyPolicyRequestSchema.parse({ serverId: ULID, sfwOnly: true });
    expect(result).not.toHaveProperty('serverId');
    expect(result.sfwOnly).toBe(true);
  });

  it('rejects an invalid profanityFilter value', () => {
    expect(updateSafetyPolicyRequestSchema.safeParse({ profanityFilter: 'nope' }).success).toBe(
      false,
    );
  });
});
