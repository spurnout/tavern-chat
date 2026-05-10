import { useState, useRef, type KeyboardEvent } from 'react';
import { Dice5, Send } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import type { Message } from '@tavern/shared';

interface Props {
  channelId: string;
}

const DICE_PREFIX = '/roll ';

export function MessageComposer({ channelId }: Props): JSX.Element {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function send(): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      if (trimmed.startsWith(DICE_PREFIX)) {
        const notation = trimmed.slice(DICE_PREFIX.length).trim();
        await api('/dice/roll', {
          method: 'POST',
          body: { channelId, notation, visibility: 'public' },
        });
      } else {
        await api<Message>(`/channels/${channelId}/messages`, {
          method: 'POST',
          body: { content: trimmed, nonce: cryptoRandomNonce() },
        });
      }
      setContent('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to send';
      setError(msg);
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="border-t border-tavern-oak bg-tavern-stone p-3">
      <div className="flex items-end gap-2">
        <button
          type="button"
          className="btn-ghost shrink-0"
          title="Roll dice (try /roll 1d20+5)"
          onClick={() => setContent((c) => (c ? c : `${DICE_PREFIX}1d20`))}
        >
          <Dice5 size={18} />
        </button>
        <textarea
          ref={textareaRef}
          className="input min-h-[2.5rem] flex-1 resize-none"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message — Shift+Enter for newline. /roll 1d20+5 to roll dice."
          disabled={busy}
          rows={1}
        />
        <button
          type="button"
          className="btn-primary shrink-0"
          disabled={busy || !content.trim()}
          onClick={() => void send()}
          aria-label="Send"
        >
          <Send size={16} />
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
