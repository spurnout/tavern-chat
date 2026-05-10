import { cn } from '../lib/cn.js';

export function TavernLogo({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <svg viewBox="0 0 64 64" className="h-9 w-9">
        <rect width="64" height="64" rx="12" fill="#0c0a09" />
        <path
          d="M22 18 L42 18 L40 46 L24 46 Z"
          fill="#f97316"
          stroke="#fbbf24"
          strokeWidth="1.5"
        />
        <ellipse cx="32" cy="20" rx="10" ry="3" fill="#fbbf24" />
      </svg>
      <div>
        <div className="text-2xl font-semibold tracking-tight">Tavern</div>
        <div className="text-xs text-tavern-mist">a cozy hall for friends</div>
      </div>
    </div>
  );
}
