import { useEffect, useState } from 'react';
import { Bookmark, Trash2, X } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { useNavigate } from '@tanstack/react-router';
import type { Message } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { messagePreview } from '../lib/message-preview.js';

interface SavedEntry {
  messageId: string;
  savedAt: string;
  note: string | null;
  message: Message;
}

/**
 * Personal bookmarks. Bell-style popover from the user footer. Click an
 * entry to navigate to the room; click the trash to unsave.
 */
export function SavedPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const channelsByServer = useRealtime((s) => s.channelsByServer);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api<{ items: SavedEntry[] }>('/me/saved')
      .then((res) => setItems(res.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [open]);

  function openEntry(entry: SavedEntry): void {
    const channelId = entry.message.channelId;
    if (channelId) {
      for (const [serverId, channels] of Object.entries(channelsByServer)) {
        if (channels.some((c) => c.id === channelId)) {
          void navigate({
            to: '/app/servers/$serverId/channels/$channelId',
            params: { serverId, channelId },
          });
          break;
        }
      }
    } else if (entry.message.dmChannelId) {
      void navigate({
        to: '/app/dms/$dmChannelId',
        params: { dmChannelId: entry.message.dmChannelId },
      });
    }
    setOpen(false);
  }

  async function unsave(messageId: string): Promise<void> {
    try {
      await api(`/me/saved/${messageId}`, { method: 'DELETE' });
      setItems((s) => s.filter((e) => e.messageId !== messageId));
    } catch {
      // Silent — list refetch on next open.
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Saved messages"
          title="Saved messages"
          className="rounded p-1 hover:bg-raised"
        >
          <Bookmark size={16} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          role="dialog"
          aria-label="Saved messages"
          className="z-40 w-96 max-w-[90vw] rounded border border-subtle bg-surface shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-subtle px-3 py-2">
            <h2 className="font-serif text-sm">Saved messages</h2>
            <Popover.Close className="rounded p-1 hover:bg-raised" aria-label="Close">
              <X size={12} />
            </Popover.Close>
          </header>
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <p className="px-3 py-4 text-sm text-fg-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-4 text-sm text-fg-muted">
                Nothing saved yet. Use the bookmark icon on a message to save it.
              </p>
            ) : (
              <ul>
                {items.map((e) => (
                  <li
                    key={e.messageId}
                    className="border-b border-subtle px-3 py-2 text-sm"
                  >
                    <div className="flex items-baseline gap-2">
                      <button
                        type="button"
                        onClick={() => openEntry(e)}
                        className="font-medium hover:underline"
                      >
                        {e.message.author.displayName}
                      </button>
                      <span className="ml-auto text-xs text-fg-muted">
                        {new Date(e.savedAt).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        onClick={() => void unsave(e.messageId)}
                        className="rounded p-1 text-fg-muted hover:bg-raised"
                        aria-label="Unsave"
                        title="Unsave"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => openEntry(e)}
                      className="mt-1 line-clamp-3 w-full text-left text-fg-muted hover:underline"
                    >
                      {messagePreview(e.message)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
