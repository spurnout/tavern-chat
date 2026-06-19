import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import type { Member, Role } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { EmptyState } from '../EmptyState.js';

export function MembersPanel({ serverId }: { serverId: string }): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  async function refresh(): Promise<void> {
    setLoadState('loading');
    try {
      const [m, r] = await Promise.all([
        api<Member[]>(`/servers/${serverId}/members`),
        api<Role[]>(`/servers/${serverId}/roles`),
      ]);
      setMembers(m);
      setRoles(r);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function setMemberRoles(userId: string, roleIds: string[]): Promise<void> {
    if (pending.has(userId)) return;
    setError(null);
    setPending((prev) => new Set(prev).add(userId));
    try {
      await api(`/servers/${serverId}/members/${userId}/roles`, {
        method: 'PUT',
        body: { roleIds },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update roles');
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {loadState === 'loading' ? (
        <p className="text-sm text-fg-muted">Loading members…</p>
      ) : loadState === 'error' ? (
        <p className="text-sm text-fg-muted">Couldn&apos;t load the members. Try again in a moment.</p>
      ) : members.length === 0 ? (
        <EmptyState
          icon={<Users size={40} strokeWidth={1.5} />}
          title="No other members yet."
          description="When folks pull up a chair, you’ll see them here."
        />
      ) : (
        <ul className="space-y-2">
          {members.map((m) => {
            const name = m.nickname ?? m.user.displayName;
            const userPending = pending.has(m.userId);
            return (
              <li key={m.userId} className="card flex flex-wrap items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised font-serif text-sm font-semibold">
                  {name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-serif font-medium">{name}</div>
                  <div className="text-xs text-fg-muted">
                    joined{' '}
                    <time className="font-mono">
                      {new Date(m.joinedAt).toLocaleDateString()}
                    </time>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {roles
                    .filter((r) => !r.isEveryone)
                    .map((r) => {
                      const has = m.roles.includes(r.id);
                      return (
                        <button
                          key={r.id}
                          disabled={userPending}
                          className={`rounded border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${
                            has
                              ? 'border-ember bg-tint-ember text-mead'
                              : 'border-subtle text-fg-muted hover:bg-raised'
                          }`}
                          onClick={() => {
                            const next = has
                              ? m.roles.filter((id) => id !== r.id)
                              : [...m.roles, r.id];
                            void setMemberRoles(m.userId, next);
                          }}
                        >
                          {r.name}
                        </button>
                      );
                    })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
