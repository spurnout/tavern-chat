import { useEffect, useState } from 'react';
import type { Member } from '@tavern/shared';
import { api } from '../lib/api-client.js';

type LoadState = 'loading' | 'loaded' | 'error';

export function MemberSidebar({ serverId }: { serverId: string }): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  // FE-10: distinguish loading / error / empty so a network failure doesn't
  // present as "No members yet." (which looks like real success).
  const [loadState, setLoadState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    api<Member[]>(`/servers/${serverId}/members`)
      .then((m) => {
        if (cancelled) return;
        setMembers(m);
        setLoadState('loaded');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-l border-subtle bg-sunken lg:flex">
      <div className="border-b border-subtle px-3 py-2 text-xs uppercase tracking-wider text-fg-muted">
        Members — {loadState === 'loaded' ? members.length : '…'}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {members.map((m) => (
          <div
            key={m.userId}
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-raised"
          >
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-raised font-serif text-xs font-semibold">
              {m.userId.slice(-2).toUpperCase()}
            </div>
            <span className="truncate font-serif text-sm">{m.nickname ?? m.userId.slice(0, 8)}</span>
          </div>
        ))}
        {loadState === 'loading' && members.length === 0 ? (
          <div className="mt-6 text-center text-xs text-fg-muted">Loading members…</div>
        ) : null}
        {loadState === 'error' && members.length === 0 ? (
          <div className="mt-6 text-center text-xs text-fg-muted">Couldn&apos;t load members.</div>
        ) : null}
        {loadState === 'loaded' && members.length === 0 ? (
          <div className="mt-6 text-center text-xs text-fg-muted">No members yet.</div>
        ) : null}
      </div>
    </aside>
  );
}
