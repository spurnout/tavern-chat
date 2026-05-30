import { useEffect, useState } from 'react';
import type { Member, Role } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';

export function MembersPanel({ serverId }: { serverId: string }): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [m, r] = await Promise.all([
        api<Member[]>(`/servers/${serverId}/members`),
        api<Role[]>(`/servers/${serverId}/roles`),
      ]);
      setMembers(m);
      setRoles(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load members');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function setMemberRoles(userId: string, roleIds: string[]): Promise<void> {
    try {
      await api(`/servers/${serverId}/members/${userId}/roles`, {
        method: 'PUT',
        body: { roleIds },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update roles');
    }
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-2">
        {members.map((m) => {
          const name = m.nickname ?? m.user.displayName;
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
                      className={`rounded border px-2 py-0.5 text-xs ${
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
    </div>
  );
}
