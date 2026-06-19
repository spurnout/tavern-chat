import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

interface ErrorAlertProps {
  children: ReactNode;
  /** Extra classes — e.g. spacing — layered over the base error style. */
  className?: string;
}

/**
 * Inline form / auth error banner. Renders `role="alert"` so assistive tech
 * announces the message the instant it appears — the bare `<p class="text-danger">`
 * pattern this replaces was silent, so a blind user submitting a wrong password
 * or invalid invite code got no feedback at all.
 *
 * Visible style is identical to the old inline error (sentence-case, host voice —
 * see the design-system Voice section), so it's a drop-in. Only render it when
 * there IS an error; an empty alert region announces nothing.
 */
export function ErrorAlert({ children, className }: ErrorAlertProps): JSX.Element {
  return (
    <p role="alert" className={cn('text-sm text-danger', className)}>
      {children}
    </p>
  );
}
