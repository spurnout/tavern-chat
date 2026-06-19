/**
 * W6 dedupe coverage — the shared `ensureMembers` roster action.
 *
 * The server member roster used to be fetched twice per room open (the
 * ChannelSidebar presence hydration + the MemberSidebar render). Both call
 * sites now funnel through `ensureMembers`, which coalesces concurrent callers
 * onto a single `GET /servers/:id/members`, caches the result, and hydrates
 * presence in the same atomic update. These tests pin that contract plus the
 * MEMBER_REMOVE / SERVER_REMOVE store mutations that keep the cache honest.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '@tavern/shared';
import { useRealtime } from './store.js';
import { api } from './api-client.js';

vi.mock('./api-client.js', () => {
  class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { ApiError, api: vi.fn() };
});

const SERVER_ID = '01HSERVER0000000000000000';
const USER_A = '01HUSERA00000000000000000';
const USER_B = '01HUSERB00000000000000000';

function member(userId: string, overrides: Partial<Member> = {}): Member {
  return {
    serverId: SERVER_ID,
    userId,
    user: {
      id: userId,
      displayName: `User ${userId.slice(-1)}`,
      username: `user_${userId.slice(-1)}`,
      presence: 'active',
    },
    nickname: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    timeoutUntil: null,
    roles: [],
    ...overrides,
  };
}

function resetStore(): void {
  useRealtime.setState({
    serversById: {},
    channelsByServer: {},
    membersByServer: {},
    membersLoadByServer: {},
    presenceByUserId: {},
  });
}

describe('realtime store — ensureMembers (W6 roster dedupe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('coalesces two concurrent calls onto a single fetch and hydrates presence', async () => {
    const roster = [
      member(USER_A, { user: { id: USER_A, displayName: 'A', username: 'a', presence: 'active' } }),
      member(USER_B, { user: { id: USER_B, displayName: 'B', username: 'b', presence: 'idle' } }),
    ];
    vi.mocked(api).mockResolvedValue(roster);

    // Two consumers mounting in the same tick — do NOT await individually.
    const p1 = useRealtime.getState().ensureMembers(SERVER_ID);
    const p2 = useRealtime.getState().ensureMembers(SERVER_ID);
    await Promise.all([p1, p2]);

    // Exactly one network call despite two callers.
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(`/servers/${SERVER_ID}/members`);

    const state = useRealtime.getState();
    expect(state.membersByServer[SERVER_ID]?.map((m) => m.userId)).toEqual([USER_A, USER_B]);
    expect(state.membersLoadByServer[SERVER_ID]).toBe('loaded');
    // Presence hydrated from the roster snapshot.
    expect(state.presenceByUserId[USER_A]).toBe('active');
    expect(state.presenceByUserId[USER_B]).toBe('idle');
  });

  it('reuses a loaded roster (no refetch) unless force is passed', async () => {
    vi.mocked(api).mockResolvedValue([member(USER_A)]);
    await useRealtime.getState().ensureMembers(SERVER_ID);
    expect(api).toHaveBeenCalledTimes(1);

    // Already 'loaded' — a plain call is a no-op.
    await useRealtime.getState().ensureMembers(SERVER_ID);
    expect(api).toHaveBeenCalledTimes(1);

    // force bypasses the short-circuit and refetches.
    vi.mocked(api).mockResolvedValue([member(USER_A), member(USER_B)]);
    await useRealtime.getState().ensureMembers(SERVER_ID, { force: true });
    expect(api).toHaveBeenCalledTimes(2);
    expect(useRealtime.getState().membersByServer[SERVER_ID]).toHaveLength(2);
  });

  it('marks the roster errored when the fetch rejects', async () => {
    vi.mocked(api).mockRejectedValue(new Error('boom'));
    await useRealtime.getState().ensureMembers(SERVER_ID);
    expect(useRealtime.getState().membersLoadByServer[SERVER_ID]).toBe('error');
    expect(useRealtime.getState().membersByServer[SERVER_ID]).toBeUndefined();
  });

  it('removeMember splices a member out of a cached roster', async () => {
    vi.mocked(api).mockResolvedValue([member(USER_A), member(USER_B)]);
    await useRealtime.getState().ensureMembers(SERVER_ID);

    useRealtime.getState().removeMember(SERVER_ID, USER_A);
    expect(useRealtime.getState().membersByServer[SERVER_ID]?.map((m) => m.userId)).toEqual([
      USER_B,
    ]);
  });

  it('removeMember preserves the reference when the roster or member is absent', async () => {
    // No cached roster yet — same-state return (no-op).
    const before = useRealtime.getState().membersByServer;
    useRealtime.getState().removeMember(SERVER_ID, USER_A);
    expect(useRealtime.getState().membersByServer).toBe(before);

    // Cached roster, but the target userId isn't present — same array ref.
    vi.mocked(api).mockResolvedValue([member(USER_A)]);
    await useRealtime.getState().ensureMembers(SERVER_ID);
    const list = useRealtime.getState().membersByServer[SERVER_ID];
    useRealtime.getState().removeMember(SERVER_ID, USER_B);
    expect(useRealtime.getState().membersByServer[SERVER_ID]).toBe(list);
  });

  it('removeServer clears both the roster and the load-state slices', async () => {
    vi.mocked(api).mockResolvedValue([member(USER_A)]);
    await useRealtime.getState().ensureMembers(SERVER_ID);
    expect(useRealtime.getState().membersByServer[SERVER_ID]).toBeDefined();
    expect(useRealtime.getState().membersLoadByServer[SERVER_ID]).toBe('loaded');

    useRealtime.getState().removeServer(SERVER_ID);
    expect(useRealtime.getState().membersByServer[SERVER_ID]).toBeUndefined();
    expect(useRealtime.getState().membersLoadByServer[SERVER_ID]).toBeUndefined();
  });
});
