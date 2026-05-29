import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@tavern/shared';
import { useRealtime } from './store.js';

const CHANNEL_ID = '01HCHANNEL000000000000000';
const THREAD_ID = '01HTHREAD0000000000000000';
const USER_ID = '01HUSER000000000000000000';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: '01HMESSAGE000000000000000',
    serverId: '01HSERVER000000000000000',
    channelId: CHANNEL_ID,
    dmChannelId: null,
    authorId: USER_ID,
    author: { id: USER_ID, displayName: 'Alice', username: 'alice' },
    type: 'default',
    content: 'hello',
    replyToMessageId: null,
    editedAt: null,
    deletedAt: null,
    safetyState: 'allowed',
    attachmentIds: [],
    reactions: [],
    diceRollId: null,
    diceRoll: null,
    pollId: null,
    threadId: null,
    isThreadRoot: false,
    threadSummary: null,
    replyTo: null,
    forwardedFrom: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function resetStore(): void {
  useRealtime.setState({
    messagesByChannel: {},
    messagesByThread: {},
    messagesByDmChannel: {},
  });
}

describe('realtime store — thread messages', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps thread replies out of the main channel message list', () => {
    const reply = message({ threadId: THREAD_ID });

    useRealtime.getState().upsertMessage(reply);

    expect(useRealtime.getState().messagesByChannel[CHANNEL_ID]).toBeUndefined();
  });

  it('stores, updates, reacts to, and removes thread messages by thread id', () => {
    const reply = message({ threadId: THREAD_ID });
    useRealtime.getState().upsertThreadMessage(reply);

    expect(useRealtime.getState().messagesByThread[THREAD_ID]?.map((m) => m.id)).toEqual([
      reply.id,
    ]);

    useRealtime.getState().applyReaction('add', { messageId: reply.id, userId: USER_ID, emoji: '🔥' }, USER_ID);
    expect(useRealtime.getState().messagesByThread[THREAD_ID]?.[0]?.reactions).toEqual([
      { emoji: '🔥', count: 1, me: true },
    ]);

    useRealtime.getState().removeThreadMessage(reply.id);
    expect(useRealtime.getState().messagesByThread[THREAD_ID]).toEqual([]);
  });
});
