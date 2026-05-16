import { useEffect, useState } from 'react';
import { CalendarPlus, Copy, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface IcalRow {
  id: string;
  kind: 'all' | 'campaign';
  campaignId: string | null;
  secretToken: string;
  createdAt: string;
}

function feedUrl(token: IcalRow): string {
  const base = `${window.location.origin}/api/calendar/${token.kind}/feed.ics`;
  const params = new URLSearchParams({ token: token.secretToken });
  if (token.campaignId) params.set('campaignId', token.campaignId);
  return `${base}?${params.toString()}`;
}

export function AccountCalendarSection(): JSX.Element {
  const [rows, setRows] = useState<IcalRow[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const r = await api<IcalRow[]>('/me/ical-tokens');
      setRows(r);
    } catch {
      // silent
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function mint(): Promise<void> {
    setBusy(true);
    try {
      await api('/me/ical-tokens', { method: 'POST', body: { kind: 'all' } });
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not mint subscription');
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/me/ical-tokens/${id}`, { method: 'DELETE' });
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  }
  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      toast.info('Feed URL copied.');
    } catch {
      toast.error('Clipboard unavailable; copy the URL manually.');
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Calendar subscription</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Subscribe your calendar app to your campaign sessions. Paste the URL into Google Calendar,
        Apple Calendar, or Outlook.
      </p>
      <div className="mt-3 space-y-2 text-sm">
        {rows.length === 0 ? (
          <p className="text-fg-muted">No subscriptions yet.</p>
        ) : (
          rows.map((r) => {
            const url = feedUrl(r);
            return (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded border border-subtle bg-canvas px-3 py-2"
              >
                <span className="font-mono text-xs text-fg-muted">
                  {r.kind === 'all' ? 'All campaigns' : `Campaign ${r.campaignId}`}
                </span>
                <span className="ml-auto truncate font-mono text-xs">{url}</span>
                <button
                  type="button"
                  className="rounded p-1 text-fg-muted hover:bg-raised"
                  onClick={() => void copy(url)}
                  aria-label="Copy URL"
                  title="Copy"
                >
                  <Copy size={12} />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-fg-muted hover:bg-raised"
                  onClick={() => void revoke(r.id)}
                  aria-label="Revoke"
                  title="Revoke"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })
        )}
        <button type="button" className="btn-primary" onClick={() => void mint()} disabled={busy}>
          <CalendarPlus size={14} className="mr-1.5 inline-block" /> Create subscription URL
        </button>
      </div>
    </section>
  );
}
