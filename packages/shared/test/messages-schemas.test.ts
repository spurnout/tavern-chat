import { describe, expect, it } from 'vitest';
import {
  createMessageRequestSchema,
  listMessagesQuerySchema,
  messageAuthorSchema,
  messageSchema,
  messageTypeSchema,
  safetyStateSchema,
  updateMessageRequestSchema,
} from '../src/schemas/messages.js';
import { MESSAGE_LIMITS } from '../src/constants.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('messageTypeSchema', () => {
  it.each(['default', 'system', 'voice', 'dice_roll', 'session_event'])(
    'accepts type %s',
    (type) => {
      expect(messageTypeSchema.safeParse(type).success).toBe(true);
    },
  );

  it('rejects an unknown type', () => {
    expect(messageTypeSchema.safeParse('reaction').success).toBe(false);
  });
});

describe('safetyStateSchema', () => {
  it.each(['allowed', 'labeled', 'warning', 'blurred', 'held', 'quarantined', 'blocked'])(
    'accepts safety state %s',
    (state) => {
      expect(safetyStateSchema.safeParse(state).success).toBe(true);
    },
  );

  it('rejects an unknown safety state', () => {
    expect(safetyStateSchema.safeParse('flagged').success).toBe(false);
  });
});

describe('messageAuthorSchema', () => {
  it('accepts a well-formed author', () => {
    const result = messageAuthorSchema.safeParse({
      id: ULID,
      displayName: 'Gandalf',
      username: 'gandalf',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an author with a non-ULID id', () => {
    expect(
      messageAuthorSchema.safeParse({ id: 'nope', displayName: 'x', username: 'x' }).success,
    ).toBe(false);
  });

  it('rejects an author missing username', () => {
    expect(messageAuthorSchema.safeParse({ id: ULID, displayName: 'x' }).success).toBe(false);
  });
});

const baseMessage = {
  id: ULID,
  serverId: ULID,
  channelId: ULID,
  dmChannelId: null,
  authorId: ULID,
  author: { id: ULID, displayName: 'Gandalf', username: 'gandalf' },
  type: 'default',
  content: 'You shall not pass',
  replyToMessageId: null,
  editedAt: null,
  deletedAt: null,
  safetyState: 'allowed',
  attachmentIds: [],
  reactions: [],
  diceRollId: null,
  createdAt: new Date().toISOString(),
};

describe('messageSchema', () => {
  it('accepts a minimal server message', () => {
    expect(messageSchema.safeParse(baseMessage).success).toBe(true);
  });

  it('accepts a DM message with nulled server/channel ids', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      serverId: null,
      channelId: null,
      dmChannelId: ULID,
    });
    expect(result.success).toBe(true);
  });

  it('accepts reactions with counts and the `me` flag', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      reactions: [
        { emoji: '🔥', count: 3, me: true },
        { emoji: '👍', count: 0, me: false },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full dice_roll message with inline diceRoll payload', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      type: 'dice_roll',
      diceRollId: ULID,
      diceRoll: {
        notation: '2d6+3',
        terms: [
          {
            kind: 'dice',
            count: 2,
            faces: 6,
            keep: null,
            rolls: [
              { value: 4, kept: true },
              { value: 2, kept: true },
            ],
            sign: 1,
            subtotal: 6,
          },
          { kind: 'modifier', value: 3, sign: 1, subtotal: 3 },
        ],
        total: 9,
        label: 'Attack',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit null diceRoll', () => {
    expect(messageSchema.safeParse({ ...baseMessage, diceRoll: null }).success).toBe(true);
  });

  it('accepts optional pollId / threadId / isThreadRoot', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      pollId: ULID,
      threadId: ULID2,
      isThreadRoot: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a threadSummary on a thread-root message', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      isThreadRoot: true,
      threadSummary: {
        threadId: ULID,
        replyCount: 5,
        lastActivityAt: new Date().toISOString(),
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a replyTo preview block', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      replyTo: {
        id: ULID2,
        authorDisplayName: 'Frodo',
        contentExcerpt: 'What about second breakfast?',
        deleted: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a forwardedFrom provenance block with a null channelId', () => {
    const result = messageSchema.safeParse({
      ...baseMessage,
      forwardedFrom: {
        messageId: ULID2,
        channelId: null,
        authorDisplayName: 'Sam',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-ULID id', () => {
    expect(messageSchema.safeParse({ ...baseMessage, id: 'bad' }).success).toBe(false);
  });

  it('rejects a bad message type', () => {
    expect(messageSchema.safeParse({ ...baseMessage, type: 'nope' }).success).toBe(false);
  });

  it('rejects a non-datetime createdAt', () => {
    expect(messageSchema.safeParse({ ...baseMessage, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('rejects a negative reaction count', () => {
    expect(
      messageSchema.safeParse({
        ...baseMessage,
        reactions: [{ emoji: 'x', count: -1, me: false }],
      }).success,
    ).toBe(false);
  });

  it('rejects a threadSummary with a non-datetime lastActivityAt', () => {
    expect(
      messageSchema.safeParse({
        ...baseMessage,
        threadSummary: { threadId: ULID, replyCount: 1, lastActivityAt: 'soon' },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing required field (author)', () => {
    const { author: _author, ...withoutAuthor } = baseMessage;
    expect(messageSchema.safeParse(withoutAuthor).success).toBe(false);
  });
});

describe('createMessageRequestSchema', () => {
  it('accepts a plain text message', () => {
    expect(createMessageRequestSchema.safeParse({ content: 'hello' }).success).toBe(true);
  });

  it('accepts an attachment-only message with empty content', () => {
    const result = createMessageRequestSchema.safeParse({
      content: '',
      attachmentIds: [ULID],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a forward with empty content via forwardedFromMessageId', () => {
    const result = createMessageRequestSchema.safeParse({
      content: '   ',
      forwardedFromMessageId: ULID,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional nonce and replyToMessageId', () => {
    const result = createMessageRequestSchema.safeParse({
      content: 'reply',
      replyToMessageId: ULID,
      nonce: 'idem-key-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty message with no attachments and no forward (superRefine)', () => {
    const result = createMessageRequestSchema.safeParse({ content: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects content over the max length', () => {
    const result = createMessageRequestSchema.safeParse({
      content: 'a'.repeat(MESSAGE_LIMITS.MAX_CONTENT_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects more attachments than the per-message cap', () => {
    const result = createMessageRequestSchema.safeParse({
      content: 'x',
      attachmentIds: Array.from(
        { length: MESSAGE_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE + 1 },
        () => ULID,
      ),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty nonce', () => {
    expect(createMessageRequestSchema.safeParse({ content: 'x', nonce: '' }).success).toBe(false);
  });

  it('rejects an over-long nonce', () => {
    expect(
      createMessageRequestSchema.safeParse({ content: 'x', nonce: 'n'.repeat(65) }).success,
    ).toBe(false);
  });

  it('rejects a non-ULID attachment id', () => {
    expect(
      createMessageRequestSchema.safeParse({ content: 'x', attachmentIds: ['bad'] }).success,
    ).toBe(false);
  });
});

describe('updateMessageRequestSchema', () => {
  it('accepts content within the limit', () => {
    expect(updateMessageRequestSchema.safeParse({ content: 'edited' }).success).toBe(true);
  });

  it('accepts empty content (no superRefine on update)', () => {
    expect(updateMessageRequestSchema.safeParse({ content: '' }).success).toBe(true);
  });

  it('rejects content over the max length', () => {
    expect(
      updateMessageRequestSchema.safeParse({
        content: 'a'.repeat(MESSAGE_LIMITS.MAX_CONTENT_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a missing content field', () => {
    expect(updateMessageRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('listMessagesQuerySchema', () => {
  it('defaults limit to 50 when omitted', () => {
    const parsed = listMessagesQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
  });

  it('coerces a string limit to a number', () => {
    const parsed = listMessagesQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });

  it('accepts before/after cursors', () => {
    const result = listMessagesQuerySchema.safeParse({ before: ULID, after: ULID2 });
    expect(result.success).toBe(true);
  });

  it('rejects a limit below 1', () => {
    expect(listMessagesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('rejects a limit above 100', () => {
    expect(listMessagesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('rejects a non-ULID before cursor', () => {
    expect(listMessagesQuerySchema.safeParse({ before: 'bad' }).success).toBe(false);
  });
});
