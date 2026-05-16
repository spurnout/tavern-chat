import { useInbox } from './inbox-store.js';

/**
 * Wave 3 #28 — App badging API. When supported (Chromium-family, iOS PWA),
 * the OS dock / home-screen icon shows the unread mention count.
 *
 * Subscribes to the inbox-store and pushes the total into
 * `navigator.setAppBadge`. Gracefully no-ops when unsupported.
 */
export function startBadging(): () => void {
  const apply = (total: number): void => {
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge) return;
    if (total > 0) {
      void nav.setAppBadge(total).catch(() => undefined);
    } else {
      void nav.clearAppBadge?.().catch(() => undefined);
    }
  };
  apply(useInbox.getState().totalUnreadMentions);
  return useInbox.subscribe((s) => apply(s.totalUnreadMentions));
}
