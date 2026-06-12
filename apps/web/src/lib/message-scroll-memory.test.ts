import { describe, expect, it } from 'vitest';
import {
  messageScrollDistanceFromBottom,
  readMessageScrollSnapshot,
  resolveMessageScrollTop,
  shouldStickToMessageBottom,
  type MessageScrollMetrics,
} from './message-scroll-memory.js';

describe('message scroll memory', () => {
  const tallList: MessageScrollMetrics = {
    scrollHeight: 2_000,
    scrollTop: 1_100,
    clientHeight: 500,
  };

  it('measures distance from the bottom', () => {
    expect(messageScrollDistanceFromBottom(tallList)).toBe(400);
  });

  it('records near-bottom snapshots as bottomed out', () => {
    const snapshot = readMessageScrollSnapshot(
      { scrollHeight: 2_000, scrollTop: 1_390, clientHeight: 500 },
      120,
    );

    expect(snapshot).toEqual({ scrollTop: 1_390, atBottom: true });
  });

  it('keeps following when the user was already at bottom before layout grew', () => {
    expect(shouldStickToMessageBottom(tallList, true, 120)).toBe(true);
    expect(shouldStickToMessageBottom(tallList, false, 120)).toBe(false);
  });

  it('restores saved offsets without scrolling past the current bottom', () => {
    expect(resolveMessageScrollTop(tallList, { scrollTop: 1_900, atBottom: false })).toBe(1_500);
    expect(resolveMessageScrollTop(tallList, { scrollTop: 1_100, atBottom: false })).toBe(1_100);
    expect(resolveMessageScrollTop(tallList, { scrollTop: 0, atBottom: true })).toBe(1_500);
  });
});
