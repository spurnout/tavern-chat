import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Dice5 } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { useAuth } from '../lib/auth.js';

interface Props {
  channelId: string;
}

export function MessageList({ channelId }: Props): JSX.Element {
  const messages = useRealtime((s) => s.messagesByChannel[channelId] ?? []);
  const setMessages = useRealtime((s) => s.setMessages);
  const me = useAuth((s) => s.me);

  const [loading, setLoading] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Message[]>(`/channels/${channelId}/messages?limit=50`)
      .then((data) => {
        if (!cancelled) setMessages(channelId, data);
      })
      .catch(() => {
        // surface errors elsewhere
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, setMessages]);

  const sorted = useMemo(() => messages, [messages]);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  // Auto-stick to bottom on new messages.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [sorted.length]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto px-4 py-4">
      {loading && sorted.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-tavern-mist">Loading…</div>
      ) : null}
      {!loading && sorted.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-tavern-mist">
          No messages yet. Start the conversation.
        </div>
      ) : null}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const message = sorted[row.index];
          if (!message) return null;
          return (
            <div
              key={message.id}
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${row.start}px)`, paddingBottom: '0.75rem' }}
              ref={virtualizer.measureElement}
              data-index={row.index}
            >
              <MessageRow message={message} mine={me?.id === message.authorId} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageRow({ message, mine }: { message: Message; mine: boolean }): JSX.Element {
  if (message.deletedAt) {
    return (
      <div className="rounded px-3 py-2 text-sm italic text-tavern-mist">
        message deleted
      </div>
    );
  }
  if (message.type === 'dice_roll') {
    return (
      <div className="rounded-md border border-tavern-oak bg-tavern-stone px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-tavern-mead">
          <Dice5 size={16} />
          <span className="font-mono">{message.content}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex items-start gap-3 rounded px-2 py-1.5 hover:bg-tavern-stone/60">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-tavern-oak text-sm font-semibold">
        {message.authorId.slice(-2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          <span className={mine ? 'font-semibold text-tavern-mead' : 'font-semibold'}>
            {message.authorId.slice(0, 8)}
          </span>
          <span className="text-xs text-tavern-mist">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
          {message.editedAt ? <span className="text-xs text-tavern-mist">(edited)</span> : null}
        </div>
        <div className="whitespace-pre-wrap break-words text-sm text-tavern-parchment">
          {message.content}
        </div>
        {message.reactions.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <span
                key={r.emoji}
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                  r.me ? 'border-tavern-ember bg-tavern-ember/10' : 'border-tavern-oak'
                }`}
              >
                <span>{r.emoji.startsWith('custom:') ? '🖼️' : r.emoji}</span>
                <span className="font-mono">{r.count}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
