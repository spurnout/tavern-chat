import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface SessionRow {
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Lists the user's active sessions and lets them revoke individual ones or
 * sign out everywhere else. The current session is highlighted when the
 * server returns a `currentSessionId` (deferred — for now all rows look
 * identical, which is still a strict improvement over no UI).
 */
export function AccountSessionsSection(): JSX.Element {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<SessionRow[]>('/me/sessions');
      setRows(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load sessions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/me/sessions/${id}`, { method: 'DELETE' });
      setRows((s) => s.filter((r) => r.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers(): Promise<void> {
    setBusy(true);
    try {
      await api('/me/sessions/revoke-others', { method: 'POST', body: {} });
      toast.info('All other sessions revoked. You may need to sign in again.');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-lg">Active sessions</h2>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => void revokeOthers()}
          disabled={busy || rows.length <= 1}
        >
          Sign out everywhere
        </button>
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        Each device that’s signed in to Tavern is a session. Revoking one signs that device out.
      </p>
      <div className="mt-3 space-y-2 text-sm">
        {loading ? (
          <p className="text-fg-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-fg-muted">No active sessions.</p>
        ) : (
          rows.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded border border-subtle bg-canvas px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{s.deviceName ?? 'Browser session'}</div>
                <div className="truncate text-xs text-fg-muted">
                  {s.ipAddress ?? '—'} · started {new Date(s.createdAt).toLocaleString()}
                </div>
                {s.userAgent ? (
                  <div className="truncate text-xs text-fg-muted">{s.userAgent}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded p-1 text-fg-muted hover:bg-raised"
                onClick={() => void revoke(s.id)}
                disabled={busy}
                aria-label="Revoke session"
                title="Revoke"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
