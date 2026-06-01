import { useEffect, useState } from 'react';
import { useBlocks } from '../lib/blocks-store.js';
import { toast } from '../lib/toast.js';

/**
 * Lists members the user has blocked and lets them unblock. Backed by the
 * shared blocks store, so the list stays live with the BLOCK_ADD / BLOCK_REMOVE
 * gateway events (e.g. a block made from a profile card in another tab).
 */
export function AccountBlockedSection(): JSX.Element {
  const blockedById = useBlocks((s) => s.blockedById);
  const loaded = useBlocks((s) => s.loaded);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void useBlocks.getState().hydrate();
  }, [loaded]);

  const rows = Object.values(blockedById).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  async function unblock(userId: string): Promise<void> {
    setBusyId(userId);
    try {
      await useBlocks.getState().unblock(userId);
    } catch {
      toast.error('Couldn’t unblock. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Blocked members</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Blocked members can’t message you, and their mentions won’t notify you. Their messages are
        collapsed in shared rooms. They aren’t told they’ve been blocked.
      </p>
      <div className="mt-3 space-y-2 text-sm">
        {!loaded ? (
          <p className="text-fg-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-fg-muted">You haven’t blocked anyone.</p>
        ) : (
          rows.map((b) => (
            <div
              key={b.userId}
              className="flex items-center gap-3 rounded border border-subtle bg-canvas px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{b.user.displayName}</div>
                <div className="truncate text-xs text-fg-muted">@{b.user.username}</div>
              </div>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => void unblock(b.userId)}
                disabled={busyId === b.userId}
              >
                Unblock
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
