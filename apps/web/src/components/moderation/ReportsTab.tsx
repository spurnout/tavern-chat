import { useCallback, useEffect, useState } from 'react';
import type { ModerationStats, Report } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';
import { BanModal } from '../BanModal.js';
import { ReportCard } from './ReportCard.js';

interface Props {
  serverId: string;
}

interface PendingBan {
  userId: string;
  displayName: string | null;
}

function ageSince(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '<1m';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d`;
}

export function ReportsTab({ serverId }: Props): JSX.Element {
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState<ModerationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingBan, setPendingBan] = useState<PendingBan | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    Promise.all([
      api<Report[]>(`/servers/${serverId}/moderation/queue`),
      api<ModerationStats>(`/servers/${serverId}/moderation/stats`).catch(() => null),
    ])
      .then(([r, s]) => {
        setReports(r);
        if (s) setStats(s);
      })
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : 'Could not load the queue.'),
      )
      .finally(() => setLoading(false));
  }, [serverId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const oldHotMs = stats?.oldestUnreviewedAt
    ? Date.now() - new Date(stats.oldestUnreviewedAt).getTime()
    : 0;
  const oldestHot = oldHotMs > 60 * 60 * 1000;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Open reports" value={String(stats?.openReports ?? '—')} hot={!!(stats && stats.openReports > 0)} />
        <StatCard label="In review" value={String(stats?.inReview ?? '—')} />
        <StatCard label="New today" value={String(stats?.newToday ?? '—')} />
        <StatCard label="Oldest unreviewed" value={ageSince(stats?.oldestUnreviewedAt ?? null)} hot={oldestHot} />
      </div>

      {loading ? <p className="text-fg-muted">Loading…</p> : null}
      {!loading && reports.length === 0 ? (
        <p className="rounded-lg border border-dashed border-subtle bg-surface p-8 text-center text-fg-muted">
          Queue is empty. Nice and quiet.
        </p>
      ) : null}
      {reports.length > 0 ? (
        <div className="space-y-3">
          {reports.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              onResolved={refresh}
              onEscalateBan={(userId, displayName) => setPendingBan({ userId, displayName })}
            />
          ))}
        </div>
      ) : null}

      <BanModal
        serverId={serverId}
        open={!!pendingBan}
        onOpenChange={(o) => {
          if (!o) setPendingBan(null);
        }}
        defaultUserId={pendingBan?.userId}
        defaultDisplayName={pendingBan?.displayName ?? undefined}
        onApplied={refresh}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hot,
}: {
  label: string;
  value: string;
  hot?: boolean;
}): JSX.Element {
  return (
    <div
      className={
        hot
          ? 'rounded-lg border border-danger bg-tint-danger p-4'
          : 'rounded-lg border border-subtle bg-surface p-4'
      }
    >
      <div className="font-serif text-2xl text-fg">{value}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
        {label}
      </div>
    </div>
  );
}
