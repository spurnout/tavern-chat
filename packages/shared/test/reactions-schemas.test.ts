import { describe, expect, it } from 'vitest';
import {
  customEmojiSchema,
  reactionEmojiSchema,
  reactionSchema,
} from '../src/schemas/reactions.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('reactionEmojiSchema', () => {
  it('accepts a unicode emoji', () => {
    expect(reactionEmojiSchema.safeParse('👍').success).toBe(true);
  });

  it('accepts a plain text shortcode-like string', () => {
    expect(reactionEmojiSchema.safeParse('thumbsup').success).toBe(true);
  });

  it('accepts a valid custom emoji reference', () => {
    expect(reactionEmojiSchema.safeParse(`custom:${ULID}`).success).toBe(true);
  });

  it('rejects a custom emoji reference with an invalid ULID', () => {
    expect(reactionEmojiSchema.safeParse('custom:not-a-ulid').success).toBe(false);
  });

  it('rejects a custom emoji reference with a too-short id', () => {
    expect(reactionEmojiSchema.safeParse('custom:01HZX7').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(reactionEmojiSchema.safeParse('').success).toBe(false);
  });

  it('rejects a string longer than 64 chars', () => {
    expect(reactionEmojiSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(reactionEmojiSchema.safeParse(123).success).toBe(false);
  });
});

describe('reactionSchema', () => {
  it('accepts a well-formed reaction', () => {
    const result = reactionSchema.safeParse({
      messageId: ULID,
      userId: ULID2,
      emoji: '🎲',
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a custom-emoji reaction', () => {
    const result = reactionSchema.safeParse({
      messageId: ULID,
      userId: ULID2,
      emoji: `custom:${ULID}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing messageId', () => {
    const result = reactionSchema.safeParse({
      userId: ULID2,
      emoji: '🎲',
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ULID userId', () => {
    const result = reactionSchema.safeParse({
      messageId: ULID,
      userId: 'nope',
      emoji: '🎲',
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-datetime createdAt', () => {
    const result = reactionSchema.safeParse({
      messageId: ULID,
      userId: ULID2,
      emoji: '🎲',
      createdAt: 'yesterday',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid emoji', () => {
    const result = reactionSchema.safeParse({
      messageId: ULID,
      userId: ULID2,
      emoji: '',
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe('customEmojiSchema', () => {
  it('accepts a well-formed custom emoji with a creator', () => {
    const result = customEmojiSchema.safeParse({
      id: ULID,
      serverId: ULID2,
      name: 'party_blob',
      attachmentId: ULID,
      createdById: ULID2,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null createdById', () => {
    const result = customEmojiSchema.safeParse({
      id: ULID,
      serverId: ULID2,
      name: 'AB12',
      attachmentId: ULID,
      createdById: null,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a name shorter than 2 chars', () => {
    const result = customEmojiSchema.safeParse({
      id: ULID,
      serverId: ULID2,
      name: 'a',
      attachmentId: ULID,
      createdById: null,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a name longer than 32 chars', () => {
    const result = customEmojiSchema.safeParse({
      id: ULID,
      serverId: ULID2,
      name: 'a'.repeat(33),
      attachmentId: ULID,
      createdById: null,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a name with disallowed characters', () => {
    const result = customEmojiSchema.safeParse({
      id: ULID,
      serverId: ULID2,
      name: 'bad-name!',
      attachmentId: ULID,
      createdById: null,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing attachmentId', () => {
    const result = customEmojiSchema.safeParse({
      id: ULID,
      serverId: ULID2,
      name: 'blob',
      createdById: null,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
