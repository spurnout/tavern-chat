import { useEffect, useState } from 'react';
import { useRealtime } from '../lib/store.js';
import { useAuth } from '../lib/auth.js';
import { typingLabel } from '../lib/typing-label.js';

const TYPING_TTL_MS = 6_000;
const EMPTY_TYPING: Record<string, number> = {};

export function TypingIndicator({ channelId }: { channelId: string }): JSX.Element | null {
  const meId = useAuth((s) => s.me?.id ?? null);
  // Subscribe to the dict; `?? {}` would create a fresh object every read.
  const typingByChannel = useRealtime((s) => s.typingByChannel);
  const typing = typingByChannel[channelId] ?? EMPTY_TYPING;
  const expire = useRealtime((s) => s.expireTyping);
  const [, force] = useState(0);

  // Tick every second so expiries clear naturally.
  useEffect(() => {
    const id = setInterval(() => {
      expire(channelId, Date.now() - TYPING_TTL_MS);
      force((n) => n + 1);
    }, 1_000);
    return () => clearInterval(id);
  }, [channelId, expire]);

  const others = Object.entries(typing).filter(
    ([uid, ts]) => uid !== meId && Date.now() - ts < TYPING_TTL_MS,
  );

  const label = typingLabel(others.length);
  if (label === null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-1 text-xs italic text-fg-muted"
    >
      <span aria-hidden className="mr-1 inline-block animate-pulse">●</span>
      {label}
    </div>
  );
}
