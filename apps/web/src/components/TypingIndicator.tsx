import { useEffect, useState } from 'react';
import { useRealtime } from '../lib/store.js';
import { useAuth } from '../lib/auth.js';

const TYPING_TTL_MS = 6_000;

export function TypingIndicator({ channelId }: { channelId: string }): JSX.Element | null {
  const meId = useAuth((s) => s.me?.id ?? null);
  const typing = useRealtime((s) => s.typingByChannel[channelId] ?? {});
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

  const others = Object.entries(typing)
    .filter(([uid, ts]) => uid !== meId && Date.now() - ts < TYPING_TTL_MS)
    .map(([uid]) => uid);

  if (others.length === 0) return null;

  const label =
    others.length === 1
      ? `${others[0]!.slice(0, 8)} is typing…`
      : others.length === 2
        ? `${others[0]!.slice(0, 8)} and ${others[1]!.slice(0, 8)} are typing…`
        : `${others.length} people are typing…`;

  return (
    <div className="px-4 py-1 text-xs italic text-tavern-mist">
      <span aria-hidden className="mr-1 inline-block animate-pulse">●</span>
      {label}
    </div>
  );
}
