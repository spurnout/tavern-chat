import { describe, expect, it } from 'vitest';
import {
  createServerRequestSchema,
  memberSchema,
  memberUserSchema,
  serverSchema,
  updateServerRequestSchema,
} from '../src/schemas/servers.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('serverSchema', () => {
  const base = {
    id: ULID,
    ownerUserId: ULID2,
    name: 'The Tavern',
    description: 'A cozy place',
    iconAttachmentId: ULID,
    defaultRoleId: ULID2,
    federationEnabled: false,
    originInstanceId: null,
    originInstanceHost: null,
    createdAt: new Date().toISOString(),
  };

  it('accepts a well-formed server', () => {
    expect(serverSchema.safeParse(base).success).toBe(true);
  });

  it('defaults originInstanceId and originInstanceHost to null when omitted', () => {
    const { originInstanceId, originInstanceHost, ...rest } = base;
    void originInstanceId;
    void originInstanceHost;
    const parsed = serverSchema.parse(rest);
    expect(parsed.originInstanceId).toBeNull();
    expect(parsed.originInstanceHost).toBeNull();
  });

  it('accepts a populated origin (mirror server)', () => {
    expect(
      serverSchema.safeParse({
        ...base,
        originInstanceId: ULID,
        originInstanceHost: 'a.example',
      }).success,
    ).toBe(true);
  });

  it('accepts a null description and null iconAttachmentId', () => {
    expect(
      serverSchema.safeParse({ ...base, description: null, iconAttachmentId: null }).success,
    ).toBe(true);
  });

  it('rejects a name shorter than 2 chars', () => {
    expect(serverSchema.safeParse({ ...base, name: 'a' }).success).toBe(false);
  });

  it('rejects a name over 64 chars', () => {
    expect(serverSchema.safeParse({ ...base, name: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects a non-boolean federationEnabled', () => {
    expect(serverSchema.safeParse({ ...base, federationEnabled: 'yes' }).success).toBe(false);
  });

  it('rejects a bad defaultRoleId', () => {
    expect(serverSchema.safeParse({ ...base, defaultRoleId: 'nope' }).success).toBe(false);
  });
});

describe('createServerRequestSchema', () => {
  it('accepts only a name', () => {
    expect(createServerRequestSchema.safeParse({ name: 'My Den' }).success).toBe(true);
  });

  it('accepts a name plus description', () => {
    expect(
      createServerRequestSchema.safeParse({ name: 'My Den', description: 'welcome' }).success,
    ).toBe(true);
  });

  it('rejects a too-short name', () => {
    expect(createServerRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('rejects a description over the limit', () => {
    expect(
      createServerRequestSchema.safeParse({ name: 'My Den', description: 'x'.repeat(2049) })
        .success,
    ).toBe(false);
  });
});

describe('updateServerRequestSchema', () => {
  it('accepts an empty update', () => {
    expect(updateServerRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts iconAttachmentId null and federationEnabled toggle', () => {
    expect(
      updateServerRequestSchema.safeParse({ iconAttachmentId: null, federationEnabled: true })
        .success,
    ).toBe(true);
  });

  it('accepts a name-only update', () => {
    expect(updateServerRequestSchema.safeParse({ name: 'Renamed Den' }).success).toBe(true);
  });

  it('rejects a too-short name in an update', () => {
    expect(updateServerRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('rejects a non-boolean federationEnabled', () => {
    expect(updateServerRequestSchema.safeParse({ federationEnabled: 1 }).success).toBe(false);
  });
});

describe('memberUserSchema', () => {
  it('defaults presence to offline', () => {
    const parsed = memberUserSchema.parse({ id: ULID, displayName: 'Robin', username: 'robin' });
    expect(parsed.presence).toBe('offline');
  });

  it('accepts an explicit presence', () => {
    expect(
      memberUserSchema.safeParse({
        id: ULID,
        displayName: 'Robin',
        username: 'robin',
        presence: 'dnd',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing displayName', () => {
    expect(memberUserSchema.safeParse({ id: ULID, username: 'robin' }).success).toBe(false);
  });
});

describe('memberSchema', () => {
  const base = {
    serverId: ULID,
    userId: ULID2,
    user: { id: ULID2, displayName: 'Robin', username: 'robin', presence: 'active' as const },
    nickname: 'Rob',
    joinedAt: new Date().toISOString(),
    timeoutUntil: null,
    roles: [ULID],
  };

  it('accepts a well-formed member', () => {
    expect(memberSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a null nickname and a timeoutUntil timestamp', () => {
    expect(
      memberSchema.safeParse({
        ...base,
        nickname: null,
        timeoutUntil: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it('accepts an empty roles array', () => {
    expect(memberSchema.safeParse({ ...base, roles: [] }).success).toBe(true);
  });

  it('rejects an empty nickname when present', () => {
    expect(memberSchema.safeParse({ ...base, nickname: '' }).success).toBe(false);
  });

  it('rejects a nickname over the display-name limit', () => {
    expect(memberSchema.safeParse({ ...base, nickname: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects a bad id inside roles', () => {
    expect(memberSchema.safeParse({ ...base, roles: ['nope'] }).success).toBe(false);
  });
});
