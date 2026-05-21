import { describe, it, expect } from 'vitest';
import {
  dmCreatePayloadSchema,
  dmMessageCreatePayloadSchema,
  dmMessageUpdatePayloadSchema,
  dmMessageDeletePayloadSchema,
  dmReactionAddPayloadSchema,
  dmReactionRemovePayloadSchema,
  ENVELOPE_EVENT_TYPES,
} from '../../src/federation/index.js';

const goodRemote = 'alice@b.example';
const otherRemote = 'bob@a.example';
const dmChannelId = '01HXYZDMCHANNEL';
const messageId = '01HXYZMSGID';
const ts = '2026-05-19T00:00:00Z';

describe('federation/dms — dm.create', () => {
  it('accepts a well-formed payload', () => {
    expect(
      dmCreatePayloadSchema.parse({
        dmChannelId,
        initiatorRemoteUserId: goodRemote,
        recipientRemoteUserId: otherRemote,
        createdAt: ts,
      }),
    ).toMatchObject({ dmChannelId });
  });

  it('rejects invalid initiatorRemoteUserId', () => {
    expect(() =>
      dmCreatePayloadSchema.parse({
        dmChannelId,
        initiatorRemoteUserId: 'no-at-sign',
        recipientRemoteUserId: otherRemote,
        createdAt: ts,
      }),
    ).toThrow();
  });

  it('rejects missing recipientRemoteUserId', () => {
    expect(() =>
      dmCreatePayloadSchema.parse({
        dmChannelId,
        initiatorRemoteUserId: goodRemote,
        createdAt: ts,
      }),
    ).toThrow();
  });

  it('rejects bad createdAt format', () => {
    expect(() =>
      dmCreatePayloadSchema.parse({
        dmChannelId,
        initiatorRemoteUserId: goodRemote,
        recipientRemoteUserId: otherRemote,
        createdAt: 'not-a-date',
      }),
    ).toThrow();
  });
});

describe('federation/dms — dm.message.create', () => {
  it('accepts a well-formed payload', () => {
    expect(
      dmMessageCreatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'hello',
        createdAt: ts,
      }),
    ).toMatchObject({ messageId });
  });

  it('treats replyToMessageId as optional', () => {
    expect(
      dmMessageCreatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'hi',
        createdAt: ts,
      }).replyToMessageId,
    ).toBeUndefined();
  });

  it('accepts nullable replyToMessageId set to null', () => {
    expect(
      dmMessageCreatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'hi',
        replyToMessageId: null,
        createdAt: ts,
      }).replyToMessageId,
    ).toBeNull();
  });

  it('rejects bad authorRemoteUserId', () => {
    expect(() =>
      dmMessageCreatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: 'oops',
        content: 'hi',
        createdAt: ts,
      }),
    ).toThrow();
  });

  it('rejects missing dmChannelId', () => {
    expect(() =>
      dmMessageCreatePayloadSchema.parse({
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'hi',
        createdAt: ts,
      }),
    ).toThrow();
  });

  it('rejects content exceeding 8192 chars', () => {
    expect(() =>
      dmMessageCreatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'x'.repeat(8193),
        createdAt: ts,
      }),
    ).toThrow();
  });
});

describe('federation/dms — dm.message.update', () => {
  it('accepts a well-formed payload', () => {
    expect(
      dmMessageUpdatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'edited',
        editedAt: ts,
      }),
    ).toBeDefined();
  });

  it('rejects bad authorRemoteUserId', () => {
    expect(() =>
      dmMessageUpdatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: 'nope',
        content: 'edited',
        editedAt: ts,
      }),
    ).toThrow();
  });

  it('rejects missing editedAt', () => {
    expect(() =>
      dmMessageUpdatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'edited',
      }),
    ).toThrow();
  });

  it('rejects content exceeding 8192 chars', () => {
    expect(() =>
      dmMessageUpdatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'y'.repeat(8193),
        editedAt: ts,
      }),
    ).toThrow();
  });

  it('rejects bad editedAt datetime', () => {
    expect(() =>
      dmMessageUpdatePayloadSchema.parse({
        dmChannelId,
        messageId,
        authorRemoteUserId: goodRemote,
        content: 'edited',
        editedAt: 'yesterday',
      }),
    ).toThrow();
  });
});

describe('federation/dms — dm.message.delete', () => {
  it('accepts a well-formed payload', () => {
    expect(
      dmMessageDeletePayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        deletedAt: ts,
      }),
    ).toBeDefined();
  });

  it('rejects bad actorRemoteUserId', () => {
    expect(() =>
      dmMessageDeletePayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: 'bad',
        deletedAt: ts,
      }),
    ).toThrow();
  });

  it('rejects missing messageId', () => {
    expect(() =>
      dmMessageDeletePayloadSchema.parse({
        dmChannelId,
        actorRemoteUserId: goodRemote,
        deletedAt: ts,
      }),
    ).toThrow();
  });

  it('rejects bad deletedAt format', () => {
    expect(() =>
      dmMessageDeletePayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        deletedAt: 'now',
      }),
    ).toThrow();
  });
});

describe('federation/dms — dm.reaction.add', () => {
  it('accepts a well-formed payload', () => {
    expect(
      dmReactionAddPayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        emoji: '😀',
      }),
    ).toBeDefined();
  });

  it('rejects bad actorRemoteUserId', () => {
    expect(() =>
      dmReactionAddPayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: 'oops',
        emoji: '😀',
      }),
    ).toThrow();
  });

  it('rejects missing emoji', () => {
    expect(() =>
      dmReactionAddPayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
      }),
    ).toThrow();
  });

  it('rejects empty emoji', () => {
    expect(() =>
      dmReactionAddPayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        emoji: '',
      }),
    ).toThrow();
  });

  it('rejects emoji exceeding 64 chars', () => {
    expect(() =>
      dmReactionAddPayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        emoji: 'a'.repeat(65),
      }),
    ).toThrow();
  });
});

describe('federation/dms — dm.reaction.remove', () => {
  it('accepts a well-formed payload', () => {
    expect(
      dmReactionRemovePayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        emoji: ':smile:',
      }),
    ).toBeDefined();
  });

  it('rejects bad actorRemoteUserId', () => {
    expect(() =>
      dmReactionRemovePayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: 'oops',
        emoji: ':smile:',
      }),
    ).toThrow();
  });

  it('rejects missing dmChannelId', () => {
    expect(() =>
      dmReactionRemovePayloadSchema.parse({
        messageId,
        actorRemoteUserId: goodRemote,
        emoji: ':smile:',
      }),
    ).toThrow();
  });

  it('rejects emoji exceeding 64 chars', () => {
    expect(() =>
      dmReactionRemovePayloadSchema.parse({
        dmChannelId,
        messageId,
        actorRemoteUserId: goodRemote,
        emoji: 'z'.repeat(65),
      }),
    ).toThrow();
  });
});

describe('federation/dms — ENVELOPE_EVENT_TYPES', () => {
  it('includes the 6 new DM event types', () => {
    for (const t of [
      'dm.create',
      'dm.message.create',
      'dm.message.update',
      'dm.message.delete',
      'dm.reaction.add',
      'dm.reaction.remove',
    ]) {
      expect(ENVELOPE_EVENT_TYPES).toContain(t);
    }
  });
});
