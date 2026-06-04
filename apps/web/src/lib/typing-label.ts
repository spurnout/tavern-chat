/**
 * The "who's typing" label.
 *
 * The TypingIndicator only has user IDs in scope (the realtime member map
 * isn't available there), so the label is deliberately name-free rather than
 * leaking a raw ID into user-facing copy. When the member-hovercard data flow
 * lands, this can grow a name-aware variant.
 *
 * @param count number of *other* people currently typing (excludes self)
 * @returns the label, or null when nobody else is typing
 */
export function typingLabel(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return 'Someone is typing…';
  if (count === 2) return 'Two people are typing…';
  return `${count} people are typing…`;
}
