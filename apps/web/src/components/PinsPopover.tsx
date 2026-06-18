import { useEffect, useRef, useState } from 'react';
import { Pin, X } from 'lucide-react';
import { api } from '../lib/api-client.js';
import type { Message } from '@tavern/shared';
import { messagePreview } from '../lib/message-preview.js';

interface PinEntry {
  channelId: string;
  messageId: string;
  pinnedBy: string;
  pinnedAt: string;
  note: string | null;
  message: Message;
}

interface Props {
  channelId: string;
}

/**
 * Channel-header pin button. Clicking opens a popover of pinned messages.
 * Pinning/unpinning happens from the per-message row in MessageList; this
 * panel is read-only browsing.
 */
export function PinsPopover({ channelId }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<PinEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api<PinEntry[]>(`/channels/${channelId}/pins`)
      .then(setPins)
      .catch(() => setPins([]))
      .finally(() => setLoading(false));
  }, [open, channelId]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Pinned messages"
        title="Pinned messages"
        onClick={() => setOpen((v) => !v)}
        className="touch-target-sq rounded p-1 hover:bg-raised"
      >
        <Pin size={14} />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full z-30 mt-2 w-96 max-w-[90vw] rounded border border-subtle bg-surface shadow-lg"
          role="dialog"
          aria-label="Pinned messages"
        >
          <header className="flex items-center justify-between border-b border-subtle px-3 py-2">
            <h2 className="font-serif text-sm">Pinned messages</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 hover:bg-raised"
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </header>
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <p className="px-3 py-4 text-sm text-fg-muted">Loading…</p>
            ) : !pins || pins.length === 0 ? (
              <p className="px-3 py-4 text-sm text-fg-muted">
                Nothing pinned here yet. Use the pin icon on a message to pin it.
              </p>
            ) : (
              <ul>
                {pins.map((p) => (
                  <li key={p.messageId} className="border-b border-subtle px-3 py-2 text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{p.message.author.displayName}</span>
                      <span className="ml-auto text-xs text-fg-muted">
                        {new Date(p.pinnedAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-fg-muted">{messagePreview(p.message)}</p>
                    {p.note ? (
                      <p className="mt-1 text-xs italic text-fg-muted">— {p.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
