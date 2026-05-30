import { useEffect, useState } from 'react';
import type { ServerBan } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';
import { BanModal } from '../BanModal.js';
import { ConfirmDialog } from '../ConfirmDialog.js';

export function BansPanel({
  serverId,
  autoOpenBan,
}: {
  serverId: string;
  autoOpenBan?: boolean;
}): JSX.Element {
  const [bans, setBans] = useState<ServerBan[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [unbanTarget, setUnbanTarget] = useState<ServerBan | null>(null);
  const [banOpen, setBanOpen] = useState(!!autoOpenBan);

  const refresh = (): void => {
    setLoadState('loading');
    api<ServerBan[]>(`/servers/${serverId}/bans`)
      .then((rows) => {
        setBans(rows);
        setLoadState('loaded');
      })
      .catch(() => setLoadState('error'));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const onUnban = async (ban: ServerBan): Promise<void> => {
    try {
      await api(`/servers/${serverId}/bans/${ban.userId}`, { method: 'DELETE' });
      toast.success('Ban lifted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not lift the ban.');
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-serif text-lg font-medium">Bans</h2>
            <p className="text-xs text-fg-muted">
              Banned members are removed from the tavern, their open connections are severed,
              and they cannot rejoin until the ban is lifted.
            </p>
          </div>
          <button type="button" className="btn-danger" onClick={() => setBanOpen(true)}>
            Ask someone to leave…
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-serif text-lg font-medium">
          Active bans
          {loadState === 'loaded' ? ` (${bans.length})` : null}
        </h2>
        {loadState === 'loading' ? (
          <p className="text-xs text-fg-muted">Loading…</p>
        ) : loadState === 'error' ? (
          <p className="text-xs text-fg-muted">Couldn&apos;t load the ban list.</p>
        ) : bans.length === 0 ? (
          <p className="text-xs text-fg-muted">No active bans.</p>
        ) : (
          <ul className="space-y-1">
            {bans.map((b) => (
              <li
                key={b.userId}
                className="flex flex-wrap items-center gap-3 rounded border border-subtle bg-surface px-3 py-2 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-mono text-xs">{b.userId}</div>
                  {b.reason ? <div className="text-xs text-fg-muted">{b.reason}</div> : null}
                  <div className="text-xs text-fg-muted">
                    Banned {new Date(b.createdAt).toLocaleString()}
                    {b.expiresAt ? ` · expires ${new Date(b.expiresAt).toLocaleString()}` : ' · permanent'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setUnbanTarget(b)}
                >
                  Welcome back
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BanModal
        serverId={serverId}
        open={banOpen}
        onOpenChange={setBanOpen}
        onApplied={refresh}
      />

      {unbanTarget ? (
        <ConfirmDialog
          title="Welcome them back?"
          description={`The user will be able to rejoin via any valid invite.`}
          confirmLabel="Welcome back"
          onCancel={() => setUnbanTarget(null)}
          onConfirm={async () => {
            const target = unbanTarget;
            setUnbanTarget(null);
            await onUnban(target);
          }}
        />
      ) : null}
    </div>
  );
}
