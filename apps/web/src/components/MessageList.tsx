import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Dice5, Flag, Trash2 } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { useAuth } from '../lib/auth.js';
import { AttachmentView } from './AttachmentView.js';
import { ReactionBar } from './ReactionBar.js';
import { ReportDialog } from './ReportDialog.js';

interface Props {
  channelId: string;
}

export function MessageList({ channelId }: Props): JSX.Element {
  const messages = useRealtime((s) => s.messagesByChannel[channelId] ?? []);
  const setMessages = useRealtime((s) => s.setMessages);
  const me = useAuth((s) => s.me);

  const [loading, setLoading] = useState(false);
  const [reportTarget, setReportTarget] = useState<Message | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Message[]>(`/channels/${channelId}/messages?limit=50`)
      .then((data) => {
        if (!cancelled) setMessages(channelId, data);
      })
      .catch(() => undefined)
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
    estimateSize: () => 80,
    overscan: 8,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [sorted.length]);

  return (
    <div
      ref={parentRef}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Messages"
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      {loading && sorted.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-fg-muted">Loading…</div>
      ) : null}
      {!loading && sorted.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-fg-muted">
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
              style={{ transform: `translateY(${row.start}px)`, paddingBottom: '0.5rem' }}
              ref={virtualizer.measureElement}
              data-index={row.index}
            >
              <MessageRow
                message={message}
                mine={me?.id === message.authorId}
                onReport={() => setReportTarget(message)}
              />
            </div>
          );
        })}
      </div>
      {reportTarget ? (
        <ReportDialog
          targetType="message"
          targetId={reportTarget.id}
          serverId={reportTarget.serverId}
          onClose={() => setReportTarget(null)}
        />
      ) : null}
    </div>
  );
}

interface RowProps {
  message: Message;
  mine: boolean;
  onReport: () => void;
}

function MessageRow({ message, mine, onReport }: RowProps): JSX.Element {
  if (message.deletedAt) {
    return (
      <div className="rounded px-3 py-2 text-sm italic text-fg-muted">message deleted</div>
    );
  }
  if (message.type === 'dice_roll') {
    return (
      <div className="rounded-md border border-subtle bg-surface px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-mead">
          <Dice5 size={16} />
          <span className="font-mono">{message.content}</span>
        </div>
      </div>
    );
  }
  if (message.type === 'system') {
    return (
      <div className="px-3 py-1 text-sm italic text-fg-muted">{message.content}</div>
    );
  }
  return (
    <div className="group flex items-start gap-3 rounded px-2 py-1.5 hover:bg-tint-fg-04">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised font-serif text-sm font-semibold">
        {message.authorId.slice(-2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          <span className={mine ? 'font-serif font-medium text-mead' : 'font-serif font-medium'}>
            {message.authorId.slice(0, 8)}
          </span>
          <span className="font-mono text-xs text-fg-muted">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
          {message.editedAt ? <span className="text-xs text-fg-muted">(edited)</span> : null}
        </div>
        {message.content ? (
          <div className="whitespace-pre-wrap break-words text-sm text-fg">
            {message.content}
          </div>
        ) : null}
        {message.attachmentIds.map((id) => (
          <AttachmentView key={id} id={id} />
        ))}
        <ReactionBar message={message} />
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          onClick={onReport}
          aria-label="Report message"
          title="Report"
          className="rounded p-1 text-fg-muted hover:bg-raised"
        >
          <Flag size={14} />
        </button>
        {mine ? (
          <button
            type="button"
            onClick={() => {
              if (!confirm('Delete this message?')) return;
              api(`/messages/${message.id}`, { method: 'DELETE' }).catch((err) => {
                if (err instanceof ApiError) alert(err.message);
              });
            }}
            aria-label="Delete message"
            title="Delete"
            className="rounded p-1 text-fg-muted hover:bg-raised"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
