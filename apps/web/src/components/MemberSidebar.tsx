import { useEffect, useState } from 'react';
import type { Member } from '@tavern/shared';
import { api } from '../lib/api-client.js';

export function MemberSidebar({ serverId }: { serverId: string }): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<Member[]>(`/servers/${serverId}/members`)
      .then((m) => {
        if (!cancelled) setMembers(m);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-l border-tavern-oak bg-tavern-stone lg:flex">
      <div className="border-b border-tavern-oak px-3 py-2 text-xs uppercase tracking-wider text-tavern-mist">
        Members — {members.length}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {members.map((m) => (
          <div
            key={m.userId}
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-tavern-oak"
          >
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-tavern-oak text-xs font-semibold">
              {m.userId.slice(-2).toUpperCase()}
            </div>
            <span className="truncate text-sm">{m.nickname ?? m.userId.slice(0, 8)}</span>
          </div>
        ))}
        {members.length === 0 ? (
          <div className="mt-6 text-center text-xs text-tavern-mist">No members yet.</div>
        ) : null}
      </div>
    </aside>
  );
}
