import { dismiss, useToasts } from '../lib/toast.js';
import { cn } from '../lib/cn.js';

/**
 * Renders the active toast stack. Mount once near the app root. Uses the
 * design-system semantic tokens (no hex / no zinc/gray fallbacks).
 */
export function Toaster(): JSX.Element {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto rounded-md border bg-surface px-3 py-2 text-sm shadow-md',
            t.kind === 'error'
              ? 'border-rust text-fg'
              : t.kind === 'success'
                ? 'border-moss text-fg'
                : 'border-subtle text-fg',
          )}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <div className="flex items-start gap-2">
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-fg-muted hover:bg-raised hover:text-fg"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
