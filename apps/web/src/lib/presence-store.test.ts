/**
 * PF-2 / follow-up #32 — web store coverage for the customStatus overlay
 * carried by PRESENCE_UPDATE.
 *
 * The realtime dispatch in `realtime.ts` keys on `'customStatus' in data`
 * (raw wire payload) to distinguish "this broadcast did not touch
 * customStatus" from "the user CLEARED their status". The behaviour-level
 * tests below pin that distinction by driving the same Zod parse + presence
 * gate the dispatcher uses, then forwarding the result to the store action.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { presenceUpdatePayloadSchema } from '@tavern/shared';
import { useRealtime } from './store.js';

/**
 * Mirrors the relevant branch of `handleDispatch('PRESENCE_UPDATE')` in
 * `apps/web/src/lib/realtime.ts`. Kept as a small local helper so the test
 * can drive realistic wire payloads without booting the full GatewayClient.
 */
function applyPresenceUpdate(data: unknown): void {
  const parsed = presenceUpdatePayloadSchema.safeParse(data);
  if (!parsed.success) return;
  const store = useRealtime.getState();
  store.setPresence(parsed.data.userId, parsed.data.presence);
  if (
    typeof data === 'object' &&
    data !== null &&
    'customStatus' in (data as Record<string, unknown>)
  ) {
    const expiresAtIso = parsed.data.customStatusExpiresAt ?? null;
    store.setCustomStatus(
      parsed.data.userId,
      parsed.data.customStatus ?? null,
      expiresAtIso === null ? null : new Date(expiresAtIso),
    );
  }
}

function resetStore(): void {
  useRealtime.setState({
    presenceByUserId: {},
    customStatusByUserId: {},
  });
}

const USER_ID = '01HXXXXXXXXXXXXXXXXXXXXXXX';

describe('realtime store — customStatusByUserId', () => {
  beforeEach(() => {
    resetStore();
  });

  it('PRESENCE_UPDATE with only {userId, presence} does NOT clobber an existing customStatus', () => {
    // Seed a previously-set custom status (as if a prior broadcast had
    // carried it).
    applyPresenceUpdate({
      userId: USER_ID,
      presence: 'active',
      customStatus: 'In a session',
      customStatusExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(useRealtime.getState().customStatusByUserId[USER_ID]?.status).toBe(
      'In a session',
    );

    // A subsequent active⇄idle flap omits the customStatus fields entirely.
    // The store entry must remain unchanged — "absent" is NOT "null".
    applyPresenceUpdate({ userId: USER_ID, presence: 'idle' });

    const entry = useRealtime.getState().customStatusByUserId[USER_ID];
    expect(entry?.status).toBe('In a session');
    expect(entry?.expiresAt?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    // Presence dot DOES advance.
    expect(useRealtime.getState().presenceByUserId[USER_ID]).toBe('idle');
  });

  it("PRESENCE_UPDATE carrying customStatus: 'foo' updates the live overlay", () => {
    applyPresenceUpdate({
      userId: USER_ID,
      presence: 'active',
      customStatus: 'At the pub',
      customStatusExpiresAt: '2099-06-15T18:00:00.000Z',
    });

    const entry = useRealtime.getState().customStatusByUserId[USER_ID];
    expect(entry?.status).toBe('At the pub');
    expect(entry?.expiresAt?.toISOString()).toBe('2099-06-15T18:00:00.000Z');
  });

  it('PRESENCE_UPDATE with customStatus: null records an explicit CLEAR (status=null, not absent)', () => {
    // First set a status…
    applyPresenceUpdate({
      userId: USER_ID,
      presence: 'active',
      customStatus: 'gaming',
      customStatusExpiresAt: null,
    });
    expect(useRealtime.getState().customStatusByUserId[USER_ID]?.status).toBe(
      'gaming',
    );

    // …then explicitly clear it.
    applyPresenceUpdate({
      userId: USER_ID,
      presence: 'active',
      customStatus: null,
      customStatusExpiresAt: null,
    });

    const entry = useRealtime.getState().customStatusByUserId[USER_ID];
    // CRITICAL: the entry MUST exist (so MemberProfileCard's live-first
    // resolver knows the user cleared the status and renders no pill) —
    // missing-from-map would cause fall-through to the stale profile
    // snapshot.
    expect(entry).toBeDefined();
    expect(entry?.status).toBeNull();
    expect(entry?.expiresAt).toBeNull();
  });

  it('setCustomStatus action writes immutably (new map identity per write)', () => {
    const before = useRealtime.getState().customStatusByUserId;
    useRealtime.getState().setCustomStatus(USER_ID, 'foo', null);
    const after = useRealtime.getState().customStatusByUserId;
    expect(after).not.toBe(before);
    expect(after[USER_ID]).toEqual({ status: 'foo', expiresAt: null });
  });
});
