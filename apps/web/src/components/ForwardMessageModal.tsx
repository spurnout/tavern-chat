import { useMemo, useState } from 'react';
import { Hash, MessageCircle, X } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useRealtime } from '../lib/store.js';

interface Props {
  source: Message;
  onClose: () => void;
}

interface TargetServerChannel {
  kind: 'channel';
  serverId: string;
  channelId: string;
  serverName: string;
  channelName: string;
}
interface TargetDm {
  kind: 'dm';
  dmChannelId: string;
  label: string;
}
type Target = TargetServerChannel | TargetDm;

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function ForwardMessageModal({ source, onClose }: Props): JSX.Element {
  const serversById = useRealtime((s) => s.serversById);
  const channelsByServer = useRealtime((s) => s.channelsByServer);
  const dmChannelsById = useRealtime((s) => s.dmChannelsById);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    for (const [serverId, channels] of Object.entries(channelsByServer)) {
      const serverName = serversById[serverId]?.name ?? '…';
      for (const c of channels) {
        if (c.type === 'voice') continue;
        out.push({
          kind: 'channel',
          serverId,
          channelId: c.id,
          serverName,
          channelName: c.name,
        });
      }
    }
    for (const dm of Object.values(dmChannelsById)) {
      out.push({
        kind: 'dm',
        dmChannelId: dm.id,
        label: dm.name ?? 'Direct message',
      });
    }
    return out;
  }, [channelsByServer, dmChannelsById, serversById]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return targets.slice(0, 80);
    return targets
      .filter((t) =>
        t.kind === 'channel'
          ? `${t.serverName} ${t.channelName}`.toLowerCase().includes(q)
          : t.label.toLowerCase().includes(q),
      )
      .slice(0, 80);
  }, [targets, query]);

  async function submit(): Promise<void> {
    if (!target) return;
    setBusy(true);
    try {
      const body = {
        content: comment.trim(),
        forwardedFromMessageId: source.id,
        nonce: randomNonce(),
      };
      if (target.kind === 'channel') {
        await api(`/channels/${target.channelId}/messages`, { method: 'POST', body });
      } else {
        await api(`/dm-channels/${target.dmChannelId}/messages`, { method: 'POST', body });
      }
      toast.info('Forwarded.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not forward');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-canvas/70">
      <div className="w-full max-w-md rounded border border-subtle bg-surface p-4 shadow-lg">
        <header className="flex items-center justify-between">
          <h2 className="font-serif text-lg">Forward</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-raised" aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="mt-3 space-y-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rooms and DMs"
            className="input w-full"
            autoFocus
          />
          <ul className="max-h-64 overflow-y-auto rounded border border-subtle bg-canvas">
            {filtered.map((t) => {
              const id = t.kind === 'channel' ? t.channelId : t.dmChannelId;
              const active =
                target &&
                (target.kind === 'channel' && t.kind === 'channel'
                  ? target.channelId === t.channelId
                  : target.kind === 'dm' && t.kind === 'dm'
                    ? target.dmChannelId === t.dmChannelId
                    : false);
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setTarget(t)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-raised ${
                      active ? 'bg-raised' : ''
                    }`}
                  >
                    {t.kind === 'channel' ? (
                      <>
                        <Hash size={12} className="text-fg-muted" />
                        <span className="font-mono text-xs text-fg-muted">{t.serverName}</span>
                        <span className="truncate">#{t.channelName}</span>
                      </>
                    ) : (
                      <>
                        <MessageCircle size={12} className="text-fg-muted" />
                        <span className="truncate">{t.label}</span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment (optional)"
            className="input min-h-[3rem] w-full resize-none"
            rows={2}
          />
        </div>
        <footer className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} className="btn-primary" disabled={busy || !target}>
            Forward
          </button>
        </footer>
      </div>
    </div>
  );
}
