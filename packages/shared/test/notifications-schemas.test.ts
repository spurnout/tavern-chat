import { describe, expect, it } from 'vitest';
import {
  serverMemberNotificationPreferenceSchema,
  updateServerMemberNotificationPreferenceRequestSchema,
  updateUserNotificationPreferenceRequestSchema,
  userNotificationPreferenceSchema,
} from '../src/schemas/notifications.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const NOW = '2026-01-01T00:00:00.000Z';

describe('userNotificationPreferenceSchema', () => {
  const valid = {
    soundEnabled: true,
    volume: 80,
    chatSoundsWhileInVoice: false,
    playOnlyWhenUnfocused: true,
    mentionsOverrideMute: true,
  };

  it('accepts a minimal valid preference (optional fields omitted)', () => {
    expect(userNotificationPreferenceSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts volume at the lower bound (0)', () => {
    expect(userNotificationPreferenceSchema.safeParse({ ...valid, volume: 0 }).success).toBe(
      true,
    );
  });

  it('accepts volume at the upper bound (100)', () => {
    expect(userNotificationPreferenceSchema.safeParse({ ...valid, volume: 100 }).success).toBe(
      true,
    );
  });

  it('rejects volume above 100', () => {
    expect(userNotificationPreferenceSchema.safeParse({ ...valid, volume: 101 }).success).toBe(
      false,
    );
  });

  it('rejects a negative volume', () => {
    expect(userNotificationPreferenceSchema.safeParse({ ...valid, volume: -1 }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer volume', () => {
    expect(userNotificationPreferenceSchema.safeParse({ ...valid, volume: 50.5 }).success).toBe(
      false,
    );
  });

  it('accepts a full preference with snooze and quiet hours', () => {
    const result = userNotificationPreferenceSchema.safeParse({
      ...valid,
      snoozeUntil: NOW,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:30',
      quietHoursDays: [0, 6],
    });
    expect(result.success).toBe(true);
  });

  it('accepts null snoozeUntil and null quiet hours', () => {
    const result = userNotificationPreferenceSchema.safeParse({
      ...valid,
      snoozeUntil: null,
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed quietHoursStart', () => {
    expect(
      userNotificationPreferenceSchema.safeParse({ ...valid, quietHoursStart: '9am' }).success,
    ).toBe(false);
  });

  it('rejects a malformed quietHoursEnd', () => {
    expect(
      userNotificationPreferenceSchema.safeParse({ ...valid, quietHoursEnd: '7:5' }).success,
    ).toBe(false);
  });

  it('rejects a non-datetime snoozeUntil', () => {
    expect(
      userNotificationPreferenceSchema.safeParse({ ...valid, snoozeUntil: 'later' }).success,
    ).toBe(false);
  });

  it('rejects a quietHoursDays value above 6', () => {
    expect(
      userNotificationPreferenceSchema.safeParse({ ...valid, quietHoursDays: [7] }).success,
    ).toBe(false);
  });

  it('rejects a quietHoursDays value below 0', () => {
    expect(
      userNotificationPreferenceSchema.safeParse({ ...valid, quietHoursDays: [-1] }).success,
    ).toBe(false);
  });

  it('rejects a missing required field (soundEnabled)', () => {
    const { soundEnabled: _omit, ...rest } = valid;
    expect(userNotificationPreferenceSchema.safeParse(rest).success).toBe(false);
  });
});

describe('updateUserNotificationPreferenceRequestSchema', () => {
  it('accepts an empty object (all optional via partial)', () => {
    expect(updateUserNotificationPreferenceRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a single-field update', () => {
    expect(updateUserNotificationPreferenceRequestSchema.safeParse({ volume: 10 }).success).toBe(
      true,
    );
  });

  it('still validates provided fields', () => {
    expect(
      updateUserNotificationPreferenceRequestSchema.safeParse({ volume: 200 }).success,
    ).toBe(false);
  });
});

describe('serverMemberNotificationPreferenceSchema', () => {
  const valid = {
    serverId: ULID,
    muteAll: false,
    muteMessages: true,
    muteMentions: false,
  };

  it('accepts a well-formed preference', () => {
    expect(serverMemberNotificationPreferenceSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing serverId', () => {
    const { serverId: _omit, ...rest } = valid;
    expect(serverMemberNotificationPreferenceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-boolean muteAll', () => {
    expect(
      serverMemberNotificationPreferenceSchema.safeParse({ ...valid, muteAll: 'yes' }).success,
    ).toBe(false);
  });
});

describe('updateServerMemberNotificationPreferenceRequestSchema', () => {
  it('accepts an empty object', () => {
    expect(updateServerMemberNotificationPreferenceRequestSchema.safeParse({}).success).toBe(
      true,
    );
  });

  it('accepts a single-field update', () => {
    expect(
      updateServerMemberNotificationPreferenceRequestSchema.safeParse({ muteAll: true }).success,
    ).toBe(true);
  });

  it('strips the omitted serverId rather than validating it', () => {
    const result = updateServerMemberNotificationPreferenceRequestSchema.parse({
      serverId: ULID,
      muteAll: true,
    });
    expect(result).not.toHaveProperty('serverId');
    expect(result.muteAll).toBe(true);
  });

  it('rejects a non-boolean field value', () => {
    expect(
      updateServerMemberNotificationPreferenceRequestSchema.safeParse({ muteMessages: 1 })
        .success,
    ).toBe(false);
  });
});
