import { describe, expect, it } from 'vitest';
import {
  createDirectDmRequestSchema,
  createGroupDmRequestSchema,
  dmChannelKindSchema,
  dmChannelMemberSchema,
  dmChannelMemberUserSchema,
  dmChannelSchema,
  markDmReadRequestSchema,
  sendDmMessageRequestSchema,
  updateDmChannelRequestSchema,
} from '../src/schemas/dms.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('dmChannelKindSchema', () => {
  it.each(['direct', 'group'])('accepts %s', (v) => {
    expect(dmChannelKindSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(dmChannelKindSchema.safeParse('broadcast').success).toBe(false);
  });
});

describe('dmChannelMemberUserSchema', () => {
  it('defaults presence to offline when omitted', () => {
    const parsed = dmChannelMemberUserSchema.parse({
      id: ULID,
      displayName: 'Ash',
      username: 'ash',
    });
    expect(parsed.presence).toBe('offline');
  });

  it('accepts an explicit presence', () => {
    expect(
      dmChannelMemberUserSchema.safeParse({
        id: ULID,
        displayName: 'Ash',
        username: 'ash',
        presence: 'active',
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid presence', () => {
    expect(
      dmChannelMemberUserSchema.safeParse({
        id: ULID,
        displayName: 'Ash',
        username: 'ash',
        presence: 'lurking',
      }).success,
    ).toBe(false);
  });

  it('rejects a bad id', () => {
    expect(
      dmChannelMemberUserSchema.safeParse({ id: 'x', displayName: 'A', username: 'a' }).success,
    ).toBe(false);
  });
});

describe('dmChannelMemberSchema', () => {
  const user = { id: ULID, displayName: 'Ash', username: 'ash', presence: 'active' as const };
  const base = {
    userId: ULID,
    user,
    joinedAt: new Date().toISOString(),
    lastReadAt: new Date().toISOString(),
  };

  it('accepts a valid member', () => {
    expect(dmChannelMemberSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a null lastReadAt', () => {
    expect(dmChannelMemberSchema.safeParse({ ...base, lastReadAt: null }).success).toBe(true);
  });

  it('rejects a non-datetime joinedAt', () => {
    expect(dmChannelMemberSchema.safeParse({ ...base, joinedAt: 'now' }).success).toBe(false);
  });
});

describe('dmChannelSchema', () => {
  const member = {
    userId: ULID,
    user: { id: ULID, displayName: 'Ash', username: 'ash', presence: 'active' as const },
    joinedAt: new Date().toISOString(),
    lastReadAt: null,
  };
  const base = {
    id: ULID,
    kind: 'group' as const,
    name: 'Party Chat',
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    members: [member],
  };

  it('accepts a well-formed group channel', () => {
    expect(dmChannelSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a null name and null lastMessageAt', () => {
    expect(
      dmChannelSchema.safeParse({ ...base, name: null, lastMessageAt: null }).success,
    ).toBe(true);
  });

  it('accepts an empty members array', () => {
    expect(dmChannelSchema.safeParse({ ...base, members: [] }).success).toBe(true);
  });

  it('rejects a name over the display-name limit', () => {
    expect(dmChannelSchema.safeParse({ ...base, name: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects an invalid kind', () => {
    expect(dmChannelSchema.safeParse({ ...base, kind: 'thread' }).success).toBe(false);
  });
});

describe('createDirectDmRequestSchema', () => {
  it('accepts a valid userId', () => {
    expect(createDirectDmRequestSchema.safeParse({ userId: ULID }).success).toBe(true);
  });

  it('rejects a missing userId', () => {
    expect(createDirectDmRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('createGroupDmRequestSchema', () => {
  it('accepts 2 userIds with no name', () => {
    expect(createGroupDmRequestSchema.safeParse({ userIds: [ULID, ULID2] }).success).toBe(true);
  });

  it('accepts userIds plus a name', () => {
    expect(
      createGroupDmRequestSchema.safeParse({ userIds: [ULID, ULID2], name: 'Heroes' }).success,
    ).toBe(true);
  });

  it('rejects fewer than 2 userIds', () => {
    expect(createGroupDmRequestSchema.safeParse({ userIds: [ULID] }).success).toBe(false);
  });

  it('rejects more than 9 userIds', () => {
    const ids = Array.from({ length: 10 }, () => ULID);
    expect(createGroupDmRequestSchema.safeParse({ userIds: ids }).success).toBe(false);
  });

  it('rejects an empty name when present', () => {
    expect(
      createGroupDmRequestSchema.safeParse({ userIds: [ULID, ULID2], name: '' }).success,
    ).toBe(false);
  });
});

describe('updateDmChannelRequestSchema', () => {
  it('accepts a string name', () => {
    expect(updateDmChannelRequestSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });

  it('accepts a null name', () => {
    expect(updateDmChannelRequestSchema.safeParse({ name: null }).success).toBe(true);
  });

  it('rejects a missing name key', () => {
    expect(updateDmChannelRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(updateDmChannelRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('markDmReadRequestSchema', () => {
  it('accepts an empty body (at is optional)', () => {
    expect(markDmReadRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a datetime at', () => {
    expect(
      markDmReadRequestSchema.safeParse({ at: new Date().toISOString() }).success,
    ).toBe(true);
  });

  it('rejects a non-datetime at', () => {
    expect(markDmReadRequestSchema.safeParse({ at: 'whenever' }).success).toBe(false);
  });
});

describe('sendDmMessageRequestSchema', () => {
  it('accepts minimal content', () => {
    expect(sendDmMessageRequestSchema.safeParse({ content: 'hi' }).success).toBe(true);
  });

  it('accepts empty content (max-only constraint)', () => {
    expect(sendDmMessageRequestSchema.safeParse({ content: '' }).success).toBe(true);
  });

  it('accepts all optional fields', () => {
    expect(
      sendDmMessageRequestSchema.safeParse({
        content: 'hello',
        replyToMessageId: ULID,
        attachmentIds: [ULID, ULID2],
        nonce: 'abc123',
      }).success,
    ).toBe(true);
  });

  it('rejects content over 2000 chars', () => {
    expect(sendDmMessageRequestSchema.safeParse({ content: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });

  it('rejects more than 10 attachmentIds', () => {
    const ids = Array.from({ length: 11 }, () => ULID);
    expect(
      sendDmMessageRequestSchema.safeParse({ content: 'x', attachmentIds: ids }).success,
    ).toBe(false);
  });

  it('rejects an empty nonce', () => {
    expect(sendDmMessageRequestSchema.safeParse({ content: 'x', nonce: '' }).success).toBe(
      false,
    );
  });

  it('rejects a nonce over 64 chars', () => {
    expect(
      sendDmMessageRequestSchema.safeParse({ content: 'x', nonce: 'x'.repeat(65) }).success,
    ).toBe(false);
  });
});
