import { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface Thread {
  id: string;
  channelId: string;
  rootMessageId: string;
  title: string | null;
  archivedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  createdBy: string;
}

interface Props {
  threadId: string;
  rootMessage?: Message | null;
  onClose: () => void;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Slide-in thread side panel. Renders the thread's messages + a composer
 * scoped to the thread. Closing collapses the panel without destroying
 * the thread itself.
 */
export function ThreadPanel({ threadId, rootMessage, onClose }: Props): JSX.Element {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<Message[]>(`/threads/${threadId}/messages`)
      .then((data) => {
        if (cancelled) return;
        // Reverse so oldest is first in our local list (the API returns desc).
        setMessages([...data].reverse());
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load thread.');
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    // Best-effort: fetch the thread itself to render the title.
    // The list endpoint returns threads for a channel; we don't have a
    // single-thread fetch, so derive what we can from the root message.
    if (rootMessage?.channelId) {
      api<Thread[]>(`/channels/${rootMessage.channelId}/threads`)
        .then((threads) => {
          const t = threads.find((x) => x.id === threadId);
          if (t) setThread(t);
        })
        .catch(() => undefined);
    }
  }, [threadId, rootMessage?.channelId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const created = await api<Message>(`/threads/${threadId}/messages`, {
        method: 'POST',
        body: { content: trimmed, nonce: randomNonce() },
      });
      setMessages((prev) => [...prev, created]);
      setContent('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not post to thread');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex h-full w-96 max-w-[40vw] flex-col border-l border-subtle bg-sunken">
      <header className="flex items-center gap-2 border-b border-subtle px-3 py-2">
        <span className="font-serif text-sm">
          {thread?.title ?? (rootMessage ? excerpt(rootMessage.content) : 'Thread')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 hover:bg-raised"
          aria-label="Close thread"
        >
          <X size={14} />
        </button>
      </header>
      {rootMessage ? (
        <div className="border-b border-subtle px-3 py-2 text-sm text-fg-muted">
          <span className="font-medium text-fg">{rootMessage.author.displayName}: </span>
          {rootMessage.content || '—'}
        </div>
      ) : null}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 ? (
          <p className="py-4 text-center text-sm text-fg-muted">No replies yet.</p>
        ) : (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li key={m.id} className="text-sm">
                <span className="font-medium">{m.author.displayName}</span>{' '}
                <span className="text-fg-muted">{m.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {thread?.archivedAt ? (
        <p className="border-t border-subtle px-3 py-2 text-xs text-fg-muted">
          This thread is archived.
        </p>
      ) : (
        <div className="border-t border-subtle p-2">
          <div className="flex items-end gap-2">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Reply in thread"
              className="input min-h-[2.5rem] flex-1 resize-none"
              rows={1}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => void send()}
              disabled={busy || !content.trim()}
              aria-label="Send"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function excerpt(s: string): string {
  const t = s.trim();
  if (t.length <= 40) return t || 'Thread';
  return `${t.slice(0, 40)}…`;
}
