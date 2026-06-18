/**
 * Assertive screen-reader announcer. A dependency-free imperative helper that
 * pushes a message into a single `aria-live="assertive"` region rendered by
 * <LiveAnnouncer />. Mirrors lib/toast.ts in shape.
 *
 * Use sparingly — assertive announcements interrupt the screen reader, so they
 * are reserved for directed-at-you events the user would otherwise miss (today:
 * @mention arrival). `nonce` bumps on every call so the store always changes,
 * and the region auto-clears shortly after so it doesn't linger.
 */
import { useSyncExternalStore } from 'react';

export interface Announcement {
  message: string;
  nonce: number;
}

const CLEAR_AFTER_MS = 1_000;

const listeners = new Set<() => void>();
let current: Announcement = { message: '', nonce: 0 };

function emit(): void {
  for (const fn of listeners) fn();
}

export function announce(message: string): void {
  current = { message, nonce: current.nonce + 1 };
  emit();
  const at = current.nonce;
  // Clear after a beat so the region empties, unless a newer message has
  // already superseded this one.
  setTimeout(() => {
    if (current.nonce === at) {
      current = { message: '', nonce: current.nonce + 1 };
      emit();
    }
  }, CLEAR_AFTER_MS);
}

export function useAnnouncement(): Announcement {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => current,
  );
}
