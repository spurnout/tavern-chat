import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { DmChannel } from '@tavern/shared';
import { Modal } from './Modal.js';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { cn } from '../lib/cn.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Candidate {
  userId: string;
  displayName: string;
  username: string;
}

/**
 * Pick one or more members of your shared taverns to DM. One pick → opens
 * (or reuses) a 1:1; multi-pick → creates a group with an optional name.
 */
export function StartDmModal({ open, onOpenChange }: Props): JSX.Element {
  const navigate = useNavigate();
  const upsertDmChannel = useRealtime((s) => s.upsertDmChannel);

  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);

  // One round-trip to /api/dms/candidates returns the deduplicated set of
  // users I share a tavern with. The server keeps the join logic close to
  // the data and doesn't fan out one request per server.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPicked(new Set());
    setQuery('');
    setGroupName('');
    api<Candidate[]>('/dms/candidates')
      .then((list) => {
        if (cancelled) return;
        setCandidates(list);
      })
      .catch(() => {
        if (cancelled) return;
        setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return candidates;
    const q = query.toLowerCase();
    return candidates.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q),
    );
  }, [query, candidates]);

  function togglePick(userId: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function start(): Promise<void> {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    try {
      const ids = Array.from(picked);
      let dm: DmChannel;
      if (ids.length === 1 && ids[0]) {
        dm = await api<DmChannel>('/dms/direct', {
          method: 'POST',
          body: { userId: ids[0] },
        });
      } else {
        dm = await api<DmChannel>('/dms/group', {
          method: 'POST',
          body: {
            userIds: ids,
            ...(groupName.trim() ? { name: groupName.trim() } : {}),
          },
        });
      }
      upsertDmChannel(dm);
      onOpenChange(false);
      void navigate({ to: '/app/dms/$dmChannelId', params: { dmChannelId: dm.id } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start the conversation.');
    } finally {
      setBusy(false);
    }
  }

  const isGroup = picked.size > 1;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Start a conversation"
      description="Pick someone you share a tavern with. Add more than one for a group thread."
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-subtle px-3 py-1.5 text-sm text-fg hover:bg-raised"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={picked.size === 0 || busy}
            onClick={() => void start()}
            className="rounded bg-ember px-3 py-1.5 text-sm text-fg-on-accent hover:bg-ember-hi disabled:opacity-50"
          >
            {isGroup ? 'Start group' : 'Start chat'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find someone…"
          className="w-full rounded border border-subtle bg-canvas px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-ember"
        />
        {isGroup ? (
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name (optional)"
            className="w-full rounded border border-subtle bg-canvas px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-ember"
          />
        ) : null}
        <div className="max-h-80 overflow-y-auto rounded border border-subtle">
          {loading ? (
            <div className="p-4 text-center text-xs text-fg-muted">Loading members…</div>
          ) : null}
          {!loading && filtered.length === 0 ? (
            <div className="p-4 text-center text-xs text-fg-muted">
              No one matches.
            </div>
          ) : null}
          {filtered.map((c) => {
            const sel = picked.has(c.userId);
            return (
              <button
                key={c.userId}
                type="button"
                onClick={() => togglePick(c.userId)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                  sel ? 'bg-raised' : 'hover:bg-raised',
                )}
              >
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-raised font-serif text-xs font-semibold">
                  {c.displayName.slice(0, 2).toUpperCase()}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-serif">{c.displayName}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-muted">
                    @{c.username}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={sel}
                  readOnly
                  className="h-4 w-4 accent-ember"
                  aria-label={`Select ${c.displayName}`}
                />
              </button>
            );
          })}
        </div>
        {picked.size > 0 ? (
          <div className="text-xs text-fg-muted">
            {picked.size} selected — {isGroup ? 'group chat' : 'one-to-one'}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

