import { cn } from '../lib/cn.js';

export function TavernLogo({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn('flex items-center gap-3 text-ember', className)}>
      {/* Semantic logo colors: the mark follows the active theme while the
          wordmark resets to the normal foreground token below. */}
      <svg viewBox="0 0 64 64" className="h-9 w-9" aria-hidden="true" focusable="false">
        <rect width="64" height="64" rx="12" fill="var(--bg-canvas)" />
        <path
          d="M18 16 H46 L42 52 H22 Z"
          fill="currentColor"
          stroke="var(--mead)"
          strokeWidth="1.5"
        />
        <ellipse cx="32" cy="17" rx="15" ry="4" fill="var(--mead)" />
      </svg>
      <div className="text-fg">
        <div className="font-serif text-2xl font-medium tracking-tight">Tavern</div>
        <div className="text-xs text-fg-muted">a cozy hall for friends</div>
      </div>
    </div>
  );
}
