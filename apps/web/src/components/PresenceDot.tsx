import type { Presence } from '@tavern/shared';
import { cn } from '../lib/cn.js';

// Semantic tokens, not raw Tailwind palette — see the design-system colour
// grammar: online=moss, idle=mead, do-not-disturb=rust, offline=fg-faint.
const COLORS: Record<Presence, string> = {
  active: 'bg-moss',
  idle: 'bg-mead',
  dnd: 'bg-rust',
  offline: 'bg-fg-faint',
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
        'inline-block rounded-full ring-2 ring-sunken',
        COLORS[presence],
        className,
      )}
      style={{ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }}
    />
  );
}
