import { describe, expect, it } from 'vitest';
import { createBanRequestSchema, serverBanSchema } from '../src/schemas/bans.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
const NOW = '2026-01-01T00:00:00.000Z';

describe('createBanRequestSchema', () => {
  it('accepts a minimal request (only userId)', () => {
    expect(createBanRequestSchema.safeParse({ userId: ULID }).success).toBe(true);
  });

  it('accepts a fully populated request', () => {
    const result = createBanRequestSchema.safeParse({
      userId: ULID,
      reason: 'spamming',
      expiresAt: NOW,
      alsoDeleteRecentMessages: true,
      deleteWithinHours: 24,
    });
    expect(result.success).toBe(true);
  });

  it('accepts deleteWithinHours at the lower bound (1)', () => {
    expect(createBanRequestSchema.safeParse({ userId: ULID, deleteWithinHours: 1 }).success).toBe(
      true,
    );
  });

  it('accepts deleteWithinHours at the upper bound (168)', () => {
    expect(
      createBanRequestSchema.safeParse({ userId: ULID, deleteWithinHours: 168 }).success,
    ).toBe(true);
  });

  it('rejects deleteWithinHours below 1', () => {
    expect(createBanRequestSchema.safeParse({ userId: ULID, deleteWithinHours: 0 }).success).toBe(
      false,
    );
  });

  it('rejects deleteWithinHours above 168', () => {
    expect(
      createBanRequestSchema.safeParse({ userId: ULID, deleteWithinHours: 169 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer deleteWithinHours', () => {
    expect(
      createBanRequestSchema.safeParse({ userId: ULID, deleteWithinHours: 2.5 }).success,
    ).toBe(false);
  });

  it('rejects a reason longer than 2000 chars', () => {
    expect(
      createBanRequestSchema.safeParse({ userId: ULID, reason: 'a'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('rejects a non-datetime expiresAt', () => {
    expect(
      createBanRequestSchema.safeParse({ userId: ULID, expiresAt: 'tomorrow' }).success,
    ).toBe(false);
  });

  it('rejects a missing userId', () => {
    expect(createBanRequestSchema.safeParse({ reason: 'x' }).success).toBe(false);
  });

  it('rejects a non-ULID userId', () => {
    expect(createBanRequestSchema.safeParse({ userId: 'nope' }).success).toBe(false);
  });
});

describe('serverBanSchema', () => {
  const valid = {
    serverId: ULID,
    userId: ULID2,
    bannedByUserId: ULID,
    reason: 'griefing',
    expiresAt: NOW,
    createdAt: NOW,
  };

  it('accepts a well-formed ban', () => {
    expect(serverBanSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a permanent ban (null expiresAt) with null reason/banner', () => {
    const result = serverBanSchema.safeParse({
      ...valid,
      bannedByUserId: null,
      reason: null,
      expiresAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing createdAt', () => {
    const { createdAt: _omit, ...rest } = valid;
    expect(serverBanSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-ULID serverId', () => {
    expect(serverBanSchema.safeParse({ ...valid, serverId: 'x' }).success).toBe(false);
  });

  it('rejects a non-datetime createdAt', () => {
    expect(serverBanSchema.safeParse({ ...valid, createdAt: 'now' }).success).toBe(false);
  });
});
