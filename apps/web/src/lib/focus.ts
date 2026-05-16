import { useRealtime } from './store.js';

/**
 * Wire up Page Visibility + window focus/blur listeners that mirror the
 * "is the user looking at Tavern right now" state into the realtime store.
 *
 * Returns a cleanup function that removes both listeners. Call once at app
 * boot (e.g. from a top-level effect).
 *
 * The combined signal is `document.visibilityState === 'visible' &&
 * document.hasFocus()`. Either listener firing recomputes both sides so we
 * don't drift if the tab becomes hidden via a means that doesn't also blur
 * the window (alt-tab vs. switching browser tab differ across OSes).
 */
export function initFocusTracking(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => undefined;
  }
  const recompute = (): void => {
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    useRealtime.getState().setAppFocused(focused);
  };
  recompute();
  document.addEventListener('visibilitychange', recompute);
  window.addEventListener('focus', recompute);
  window.addEventListener('blur', recompute);
  return () => {
    document.removeEventListener('visibilitychange', recompute);
    window.removeEventListener('focus', recompute);
    window.removeEventListener('blur', recompute);
  };
}
