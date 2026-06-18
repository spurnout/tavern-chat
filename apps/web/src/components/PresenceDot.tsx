import type { Presence } from '@tavern/shared';
import { cn } from '../lib/cn.js';

// Semantic tokens, not raw Tailwind palette — see the design-system colour
// grammar: online=moss, idle=mead, do-not-disturb=rust, offline=fg-faint.
// Colour is never the sole signal (WCAG 1.4.1): each state also carries a
// distinct shape — filled circle / hollow ring / filled square — so presence
// stays legible in greyscale and for colour-blind viewers.
const SHAPES: Record<Presence, string> = {
  active: 'rounded-full bg-moss',
  idle: 'rounded-full border-2 border-mead bg-transparent',
  dnd: 'rounded-none bg-rust',
  offline: 'rounded-full border border-fg-faint bg-transparent opacity-70',
};

const LABELS: Record<Presence, string> = {
  active: 'Active',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

interface Props {
  presence: Presence;
  /** Size in tailwind units (e.g. 2 = 0.5rem). Default 2.5. */
  size?: number;
  className?: string;
}

/**
 * Small colored dot showing a user's current presence. Always renders
 * with the surface-ring used by the design system so it reads cleanly on
 * top of avatars without re-pixel-aligning per host.
 */
export function PresenceDot({ presence, size = 2.5, className }: Props): JSX.Element {
  return (
    <span
      role="img"
      aria-label={LABELS[presence]}
      title={LABELS[presence]}
      className={cn(
        'inline-block ring-2 ring-sunken',
        SHAPES[presence],
        className,
      )}
      style={{ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }}
    />
  );
}
