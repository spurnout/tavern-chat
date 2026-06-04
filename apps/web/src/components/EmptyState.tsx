import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

interface Props {
  /** Illustration slot. Defaults to the tavern-door glyph below. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Optional action(s) — usually a single button or link. */
  action?: ReactNode;
  className?: string;
}

/**
 * The shared empty / quiet state. A centered serif-glyph illustration, a
 * hospitable headline, a muted line, and an optional action. Sizes itself to
 * its container, so it works as a full-page hero and inside a 380px popover.
 *
 * Voice: write the title like a host, not a system — "All quiet for now.",
 * not "No notifications." See the design-system Voice section.
 */
export function EmptyState({ icon, title, description, action, className }: Props): JSX.Element {
  return (
    <div
      className={cn(
        'grid h-full place-items-center px-6 py-10 text-center',
        className,
      )}
    >
      <div className="max-w-sm space-y-3">
        <div className="flex justify-center text-fg-faint" aria-hidden>
          {icon ?? <TavernDoorGlyph />}
        </div>
        <h2 className="font-serif text-lg font-medium text-fg">{title}</h2>
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
        {action ? <div className="flex justify-center pt-1">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * A warm, minimal tavern doorway — an arch with a sill and a sliver of light.
 * `currentColor` so it inherits whatever tone the caller sets (fg-faint here).
 */
function TavernDoorGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 41 V20 a10 10 0 0 1 20 0 V41" />
      <path d="M10 41 H38" />
      <path d="M24 22 V34" className="opacity-60" />
    </svg>
  );
}
