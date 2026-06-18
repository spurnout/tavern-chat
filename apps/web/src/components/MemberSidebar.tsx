import { useEffect, useMemo, useState } from 'react';
import type { Member, Presence } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { cn } from '../lib/cn.js';
import { PresenceDot } from './PresenceDot.js';
import { MemberProfileTrigger } from './MemberProfileTrigger.js';

type LoadState = 'loading' | 'loaded' | 'error';

// Module-level frozen default so the "no overrides yet" path returns a stable
// reference across renders. Returning a fresh `{}` from the zustand selector
// re-fires useSyncExternalStore on every render and infinite-loops React;
// same trap as the channelsByServer fix in server-home.tsx.
const EMPTY_NICK_OVERRIDES: Record<string, string | null> = Object.freeze({});

export function MemberSidebar({
  serverId,
  open,
  onClose,
}: {
  serverId: string;
  /** Drawer state below `lg`. Ignored at `lg+`, where it's a static column. */
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  // FE-10: distinguish loading / error / empty so a network failure doesn't
  // present as "No members yet." (which looks like real success).
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const presenceByUserId = useRealtime((s) => s.presenceByUserId);
  const setPresences = useRealtime((s) => s.setPresences);
  // Nickname overlays applied on top of whatever the initial members fetch
  // returned. Updated by MEMBER_UPDATE dispatches so a rename event reflects
  // here without a refetch. Subscribe to the dict; derive the per-server
  // entry via useMemo so the empty-case fallback stays a stable reference.
  const nicknameOverridesByServer = useRealtime(
    (s) => s.nicknameOverridesByServer,
  );
  const nicknameOverrides = useMemo(
    () => nicknameOverridesByServer[serverId] ?? EMPTY_NICK_OVERRIDES,
    [nicknameOverridesByServer, serverId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    api<Member[]>(`/servers/${serverId}/members`)
      .then((m) => {
        if (cancelled) return;
        setMembers(m);
        setLoadState('loaded');
        // Hydrate the realtime store with what the server reported at fetch
        // time. PRESENCE_UPDATE events keep these fresh from here on.
        const entries: Record<string, Presence> = {};
        for (const item of m) entries[item.userId] = item.user.presence;
        setPresences(entries);
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, setPresences]);

  return (
    <>
      {/* Mobile/tablet drawer backdrop. Hidden at lg+, where the roster is a
          persistent column. */}
      {open ? (
        <button
          type="button"
          aria-label="Close members"
          className="absolute inset-0 z-10 bg-black/60 lg:hidden"
          onClick={onClose}
        />
      ) : null}
      <aside
        id="member-sidebar"
        aria-label="Members"
        className={cn(
          'absolute inset-y-0 right-0 z-20 flex w-60 shrink-0 flex-col border-l border-subtle bg-sunken transition-transform',
          'lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="border-b border-subtle px-3 py-2 text-xs uppercase tracking-wider text-fg-muted">
          Members — {loadState === 'loaded' ? members.length : '…'}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {members.map((m) => {
            const override = nicknameOverrides[m.userId];
            const effectiveNick = override !== undefined ? override : m.nickname;
            const name = effectiveNick ?? m.user.displayName;
            const presence = presenceByUserId[m.userId] ?? m.user.presence;
            const memberWithNick: Member =
              override !== undefined ? { ...m, nickname: effectiveNick } : m;
            return (
              <MemberProfileTrigger
                key={m.userId}
                userId={m.userId}
                serverId={serverId}
                member={memberWithNick}
                side="left"
                align="start"
              >
                <button
                  type="button"
                  aria-label={`View profile of ${name}`}
                  className="touch-target group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-raised focus:outline-none focus-visible:ring-1 focus-visible:ring-ember"
                >
                  <div className="relative shrink-0">
                    <div className="grid h-7 w-7 place-items-center rounded-full bg-raised font-serif text-xs font-semibold">
                      {name.slice(0, 2).toUpperCase()}
                    </div>
                    <PresenceDot
                      presence={presence}
                      className="absolute -bottom-0.5 -right-0.5"
                    />
                  </div>
                  <span className="min-w-0 flex-1 truncate font-serif text-sm">{name}</span>
                </button>
              </MemberProfileTrigger>
            );
          })}
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
    </>
  );
}
