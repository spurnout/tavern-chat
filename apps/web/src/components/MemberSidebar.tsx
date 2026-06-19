import { useEffect, useMemo } from 'react';
import type { Member } from '@tavern/shared';
import { useRealtime } from '../lib/store.js';
import { cn } from '../lib/cn.js';
import { PresenceDot } from './PresenceDot.js';
import { MemberProfileTrigger } from './MemberProfileTrigger.js';

// Module-level frozen default so the "no overrides yet" path returns a stable
// reference across renders. Returning a fresh `{}` from the zustand selector
// re-fires useSyncExternalStore on every render and infinite-loops React;
// same trap as the channelsByServer fix in server-home.tsx.
const EMPTY_NICK_OVERRIDES: Record<string, string | null> = Object.freeze({});
// Same stability trap for the roster: the selector returns the store dict
// (stable ref) and we fall back to this shared empty array, never a fresh [].
const EMPTY_MEMBERS: Member[] = [];

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
  // Roster + load state come from the shared `ensureMembers` cache so this
  // column and the ChannelSidebar's presence hydration share ONE fetch per
  // server. FE-10: the tri-state still distinguishes loading / error / empty
  // so a network failure doesn't present as "No members yet." Missing key →
  // 'loading' (the fetch effect below kicks in on mount). Select the store
  // dicts (stable refs) and derive the per-server slices via useMemo so the
  // empty-case fallbacks stay stable references.
  const ensureMembers = useRealtime((s) => s.ensureMembers);
  const membersByServer = useRealtime((s) => s.membersByServer);
  const membersLoadByServer = useRealtime((s) => s.membersLoadByServer);
  const members = useMemo(
    () => membersByServer[serverId] ?? EMPTY_MEMBERS,
    [membersByServer, serverId],
  );
  const loadState = membersLoadByServer[serverId] ?? 'loading';
  const presenceByUserId = useRealtime((s) => s.presenceByUserId);
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
    void ensureMembers(serverId);
  }, [serverId, ensureMembers]);

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
