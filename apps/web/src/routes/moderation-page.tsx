import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Shield } from 'lucide-react';
import type { AuditLogEntry, ModerationAction, Report } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';

type Tab = 'queue' | 'audit';

export function ModerationPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [tab, setTab] = useState<Tab>('queue');
  const [reports, setReports] = useState<Report[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (!serverId) return;
    setLoading(true);
    setError(null);
    try {
      if (tab === 'queue') {
        const r = await api<Report[]>(`/servers/${serverId}/moderation/queue`);
        setReports(r);
      } else {
        const a = await api<AuditLogEntry[]>(`/servers/${serverId}/audit-log`);
        setAudit(a);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, serverId]);

  if (!serverId) return <div className="p-12">Pick a den.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Shield size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Moderation</span>
        <div className="ml-auto flex gap-1 text-xs">
          <TabButton active={tab === 'queue'} onClick={() => setTab('queue')}>
            Queue
          </TabButton>
          <TabButton active={tab === 'audit'} onClick={() => setTab('audit')}>
            Audit log
          </TabButton>
        </div>
      </header>
      <div className="space-y-3 p-6">
        {error ? (
          <p className="rounded border border-danger bg-tint-danger p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {loading ? <p className="text-fg-muted">Loading…</p> : null}

        {tab === 'queue' ? (
          reports.length === 0 ? (
            <p className="text-fg-muted">Queue is empty. Nice and quiet.</p>
          ) : (
            <QueuePanel reports={reports} onChanged={() => void refresh()} />
          )
        ) : (
          <ul className="space-y-1">
            {audit.length === 0 ? (
              <p className="text-fg-muted">No audit entries yet.</p>
            ) : null}
            {audit.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline gap-2 rounded border border-subtle bg-surface px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-fg-muted">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span className="font-mono text-xs font-medium">{e.action}</span>
                {e.actorId ? (
                  <span className="text-xs text-fg-muted">by {e.actorId.slice(0, 8)}</span>
                ) : null}
                {e.targetId ? (
                  <span className="text-xs text-fg-muted">→ {e.targetId.slice(0, 8)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised'
      }`}
    >
      {children}
    </button>
  );
}

function QueuePanel({
  reports,
  onChanged,
}: {
  reports: Report[];
  onChanged: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAll(): void {
    setSelected(new Set(reports.map((r) => r.id)));
  }
  function clearAll(): void {
    setSelected(new Set());
  }

  async function bulk(
    status: 'resolved' | 'dismissed' | 'escalated',
    action?: ModerationAction,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(
        Array.from(selected).map((id) =>
          api(`/reports/${id}/resolve`, {
            method: 'POST',
            body: { status, action },
          }),
        ),
      );
      setSelected(new Set());
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bulk action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded border border-subtle bg-surface p-2 text-xs">
        <span className="text-fg-muted">{selected.size} selected</span>
        <button className="btn-ghost" onClick={selectAll} disabled={busy}>
          Select all
        </button>
        <button className="btn-ghost" onClick={clearAll} disabled={busy}>
          Clear
        </button>
        <div className="ml-auto flex gap-1">
          <button
            className="btn-ghost"
            disabled={busy || selected.size === 0}
            onClick={() => void bulk('dismissed')}
          >
            Dismiss
          </button>
          <button
            className="btn-ghost"
            disabled={busy || selected.size === 0}
            onClick={() => void bulk('resolved', 'warn_user')}
          >
            Warn
          </button>
          <button
            className="btn-primary"
            disabled={busy || selected.size === 0}
            onClick={() => void bulk('resolved', 'block')}
          >
            Block
          </button>
          <button
            className="btn-primary"
            disabled={busy || selected.size === 0}
            onClick={() => void bulk('resolved', 'quarantine')}
          >
            Quarantine
          </button>
        </div>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-3">
        {reports.map((r) => (
          <ReportRow
            key={r.id}
            report={r}
            selected={selected.has(r.id)}
            onToggle={() => toggle(r.id)}
            onResolve={onChanged}
          />
        ))}
      </ul>
    </div>
  );
}

function ReportRow({
  report,
  selected,
  onToggle,
  onResolve,
}: {
  report: Report;
  selected: boolean;
  onToggle: () => void;
  onResolve: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(
    status: 'resolved' | 'dismissed' | 'escalated',
    action?: ModerationAction,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/reports/${report.id}/resolve`, {
        method: 'POST',
        body: { status, action },
      });
      onResolve();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Resolution failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={selected}
            onChange={onToggle}
            aria-label="Select report"
          />
          <div>
            <div className="font-serif font-medium">{report.category.replace(/_/g, ' ')}</div>
            <div className="text-xs text-fg-muted">
              {report.targetType} · {report.targetId.slice(0, 8)} · reported by{' '}
              {report.reporterId.slice(0, 8)}
            </div>
          </div>
        </div>
        <span className="text-xs uppercase tracking-wider text-mead">{report.status}</span>
      </div>
      {report.notes ? (
        <p className="rounded bg-canvas p-2 text-sm text-fg">{report.notes}</p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2 text-xs">
        <button className="btn-ghost" disabled={busy} onClick={() => void resolve('dismissed')}>
          Dismiss
        </button>
        <button
          className="btn-ghost"
          disabled={busy}
          onClick={() => void resolve('resolved', 'warn_user')}
        >
          Warn user
        </button>
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => void resolve('resolved', 'block')}
        >
          Block
        </button>
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => void resolve('resolved', 'quarantine')}
        >
          Quarantine
        </button>
        <button
          className="btn bg-danger text-fg-on-accent hover:bg-danger-hi"
          disabled={busy}
          onClick={() => void resolve('resolved', 'lock_account')}
        >
          Lock account
        </button>
      </div>
    </li>
  );
}
