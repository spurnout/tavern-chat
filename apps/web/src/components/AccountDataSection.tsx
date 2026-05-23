import { useEffect, useState } from 'react';
import { Download, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface ExportRow {
  id: string;
  status: string;
  sizeBytes: number | null;
  failureReason: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
}

export function AccountDataSection(): JSX.Element {
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const r = await api<ExportRow[]>('/me/exports');
      setExports(r);
    } catch {
      // Silent — the section still renders.
    }
  }

  // Statuses where there's nothing left to update — pollung past them is
  // wasted work. The server marks an export ready/failed and the row never
  // moves on its own; the user must request a new one.
  const TERMINAL_STATUSES = new Set(['ready', 'failed', 'expired']);
  const hasInflight = exports.some((e) => !TERMINAL_STATUSES.has(e.status));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    // Lightweight poll only while there IS an inflight export; the gateway
    // also sends an EXPORT_READY event but a 4s tick is a safer floor in
    // case the user closed and reopened the tab mid-export. When no rows
    // are in flight the interval doesn't run, so an idle settings tab
    // doesn't ping the API forever.
    if (!hasInflight) return;
    const handle = window.setInterval(() => {
      void refresh();
    }, 4000);
    return () => window.clearInterval(handle);
  }, [hasInflight]);

  async function requestExport(): Promise<void> {
    setBusy(true);
    try {
      await api('/me/export', { method: 'POST', body: {} });
      toast.info('Export queued — you’ll get a notification when it’s ready.');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start export');
    } finally {
      setBusy(false);
    }
  }

  async function scheduleDelete(): Promise<void> {
    setConfirmingDelete(false);
    setBusy(true);
    try {
      const r = await api<{ scheduledDeleteAt: string; graceDays: number }>(
        '/me/delete',
        { method: 'POST', body: {} },
      );
      toast.info(
        `Account deletion scheduled for ${new Date(r.scheduledDeleteAt).toLocaleString()}. Sign in within ${r.graceDays} days to cancel.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not schedule deletion');
    } finally {
      setBusy(false);
    }
  }

  async function cancelDelete(): Promise<void> {
    setBusy(true);
    try {
      await api('/me/delete/cancel', { method: 'POST', body: {} });
      toast.info('Deletion cancelled.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  }

  function formatSize(bytes: number | null): string {
    if (!bytes) return '';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i += 1;
    }
    return `${size.toFixed(size < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Your data</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Download an archive of your messages, attachments, and audit-log entries. Or schedule your
        account for deletion.
      </p>
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <button type="button" className="btn-primary" onClick={() => void requestExport()} disabled={busy}>
          <Download size={14} className="mr-1.5 inline-block" /> Request data export
        </button>
        <button type="button" className="btn-ghost" onClick={() => void cancelDelete()} disabled={busy}>
          Cancel deletion
        </button>
        <button
          type="button"
          className="btn-ghost text-danger"
          onClick={() => setConfirmingDelete(true)}
          disabled={busy}
        >
          <AlertTriangle size={14} className="mr-1.5 inline-block" /> Delete my account
        </button>
      </div>
      {exports.length > 0 ? (
        <div className="mt-3 text-sm">
          <h3 className="text-xs uppercase tracking-wide text-fg-muted">Recent exports</h3>
          <ul className="mt-1 space-y-1">
            {exports.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span className="font-mono">{new Date(e.requestedAt).toLocaleString()}</span>
                <span>·</span>
                <span>{e.status}</span>
                {e.sizeBytes ? (
                  <>
                    <span>·</span>
                    <span>{formatSize(e.sizeBytes)}</span>
                  </>
                ) : null}
                {e.status === 'ready' ? (
                  <a
                    className="ml-auto inline-flex items-center gap-1 text-mead hover:underline"
                    href={`/api/me/exports/${encodeURIComponent(e.id)}/download`}
                  >
                    <Download size={12} /> Download
                  </a>
                ) : null}
                {e.status === 'failed' && e.failureReason ? (
                  <span className="ml-auto text-danger" title={e.failureReason}>
                    failed
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {confirmingDelete ? (
        <ConfirmDialog
          title="Delete your account?"
          description="Your data is held for 7 days. Sign in within that window to cancel; after the grace period your messages, attachments, and account are permanently removed. Tavern ownership must be transferred first."
          confirmLabel="Schedule deletion"
          destructive
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={scheduleDelete}
        />
      ) : null}
    </section>
  );
}
