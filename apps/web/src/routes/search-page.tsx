import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';

export function SearchPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channels = useRealtime((s) => (serverId ? (s.channelsByServer[serverId] ?? []) : []));

  // Debounced search + in-flight cancellation. FE-15: an AbortController
  // attached to the fetch is aborted on rapid re-typing so older queries
  // can't overwrite newer results when the network is jittery, and the
  // server isn't asked to run obsolete searches.
  useEffect(() => {
    if (!serverId) return;
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const r = await api<{ messages: Message[] }>(`/servers/${serverId}/search`, {
          query: { q: q.trim(), limit: 30 },
          signal: controller.signal,
        });
        setResults(r.messages);
      } catch (err) {
        // AbortError is the expected outcome when a newer keystroke fired —
        // don't surface it as a search failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Search failed');
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [q, serverId]);

  if (!serverId) return <div className="p-12">Pick a den.</div>;

  function channelName(id: string): string {
    return channels.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Search size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Search</span>
      </header>
      <div className="space-y-4 p-6">
        <input
          autoFocus
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search messages in this den (min 2 chars)…"
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {busy ? <p className="text-sm text-fg-muted">Searching…</p> : null}
        {!busy && q.trim().length >= 2 && results.length === 0 ? (
          <p className="text-sm text-fg-muted">No matches.</p>
        ) : null}
        <ul className="space-y-2">
          {results.map((m) => (
            <li key={m.id} className="card">
              <div className="mb-1 flex items-baseline justify-between">
                <Link
                  to="/app/servers/$serverId/channels/$channelId"
                  params={{ serverId, channelId: m.channelId }}
                  className="text-sm text-mead hover:underline"
                >
                  #{channelName(m.channelId)}
                </Link>
                <span className="font-mono text-xs text-fg-muted">
                  {new Date(m.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="whitespace-pre-wrap break-words text-sm">{m.content}</div>
              {m.attachmentIds.length > 0 ? (
                <div className="mt-1 text-xs text-fg-muted">
                  +{m.attachmentIds.length} attachment{m.attachmentIds.length === 1 ? '' : 's'}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
