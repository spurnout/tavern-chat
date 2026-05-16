import { api } from './api-client.js';
import type { Presence } from '@tavern/shared';

/**
 * Client-side presence controller.
 *
 * Owns:
 *   - the 10-minute idle timer (any keyboard / mouse / pointer event resets it)
 *   - reporting active/idle transitions to PATCH /me/presence
 *   - the manual DND toggle (forwarded to the same endpoint)
 *
 * The server tracks the sticky DND override in the User row; idle/active is
 * in-memory only and re-derived on every gateway connect. So if the page
 * reloads while idle, we'll be `active` for the first ~10 minutes until the
 * idle timer trips again. That's fine — the room sidebar will catch up.
 */

const IDLE_MS = 10 * 60 * 1000; // 10 minutes

let timer: ReturnType<typeof setTimeout> | null = null;
let lastReported: 'active' | 'idle' | null = null;
let started = false;

function resetIdleTimer(): void {
  if (timer !== null) clearTimeout(timer);
  // Any input means we're active. Report once when we transition.
  if (lastReported !== 'active') {
    void reportActivity(true);
  }
  timer = setTimeout(() => {
    void reportActivity(false);
  }, IDLE_MS);
}

async function reportActivity(active: boolean): Promise<void> {
  lastReported = active ? 'active' : 'idle';
  await api('/me/presence', {
    method: 'PATCH',
    body: { active },
  }).catch(() => undefined);
}

/**
 * Wire pointer/keyboard listeners and start the idle timer. Idempotent —
 * safe to call multiple times; second+ calls are no-ops.
 */
export function startPresenceTracking(): () => void {
  if (typeof window === 'undefined' || started) return () => undefined;
  started = true;
  const activity = (): void => resetIdleTimer();
  window.addEventListener('pointermove', activity, { passive: true });
  window.addEventListener('pointerdown', activity, { passive: true });
  window.addEventListener('keydown', activity, { passive: true });
  window.addEventListener('focus', activity);
  // Kick the timer immediately so we're known to be active at boot.
  resetIdleTimer();
  return () => {
    started = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastReported = null;
    window.removeEventListener('pointermove', activity);
    window.removeEventListener('pointerdown', activity);
    window.removeEventListener('keydown', activity);
    window.removeEventListener('focus', activity);
  };
}

/**
 * Toggle the manual DND override on the server. The PRESENCE_UPDATE
 * broadcast that follows will refresh `presenceByUserId` for everyone
 * including us — the store is the source of truth, not the response here.
 */
export async function setManualDnd(dnd: boolean): Promise<Presence> {
  const res = await api<{ presence: Presence; manualDnd: boolean }>('/me/presence', {
    method: 'PATCH',
    body: { dnd },
  });
  return res.presence;
}
