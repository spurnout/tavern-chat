import { useState } from 'react';
import { Smile } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

const QUICK_EMOJIS = ['👍', '❤️', '🎉', '😂', '🤔', '🎲', '🔥', '🏰'];

export function ReactionBar({ message }: { message: Message }): JSX.Element {
  const [picking, setPicking] = useState(false);

  async function toggle(emoji: string, currentlyMine: boolean): Promise<void> {
    const path = `/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`;
    // FE-11: previously the reaction round-trip was a silent .catch — a
    // permission failure (e.g. ADD_REACTIONS denied) gave no feedback and
    // the optimistic UI stayed wrong until the next gateway dispatch.
    try {
      await api(path, { method: currentlyMine ? 'DELETE' : 'PUT' });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Couldn't update reaction.",
      );
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => void toggle(r.emoji, r.me)}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
            r.me
              ? 'border-ember bg-tint-ember text-mead'
              : 'border-subtle hover:bg-raised'
          }`}
        >
          <span>{r.emoji.startsWith('custom:') ? '🖼' : r.emoji}</span>
          <span className="font-mono">{r.count}</span>
        </button>
      ))}
      <div className="relative">
        <button
          type="button"
          aria-label="Add reaction"
          onClick={() => setPicking((p) => !p)}
          className="rounded p-1 text-fg-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised"
        >
          <Smile size={14} />
        </button>
        {picking ? (
          <div className="absolute bottom-7 left-0 z-10 flex gap-1 rounded border border-subtle bg-surface p-1 shadow-lg">
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  setPicking(false);
                  void toggle(e, false);
                }}
                className="rounded px-1.5 py-0.5 hover:bg-raised"
              >
                {e}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
