import { useLayoutEffect } from 'react';

interface FocusTrapOptions {
  /** Element to focus when the trap activates; defaults to the first focusable. */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /** Restore focus to the previously-focused element on deactivate. Default true. */
  restoreFocus?: boolean;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Keep keyboard focus inside `containerRef` while `active` is true: move focus
 * in on activate (to `initialFocusRef`, else the first focusable), wrap Tab /
 * Shift+Tab at the edges, and restore focus to the previously-focused element
 * on deactivate. Escape handling stays the caller's concern (single
 * responsibility).
 *
 * Radix Dialog/Popover bring their own focus management, so this hook is for
 * the hand-rolled floating overlays that don't — currently the EmojiPicker.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement>,
  active: boolean,
  options: FocusTrapOptions = {},
): void {
  const { initialFocusRef, restoreFocus = true } = options;

  useLayoutEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Move focus into the trap.
    const initial = initialFocusRef?.current ?? focusables()[0] ?? null;
    initial?.focus();

    // Arrow function (not a hoisted declaration) so it inherits the non-null
    // narrowing of `container` from the guard above.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, initialFocusRef, restoreFocus]);
}
