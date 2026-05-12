import { useEffect, useState } from 'react';
import type {
  Campaign,
  CampaignSession,
  CreateCampaignSessionRequest,
} from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';

export function SessionsTab({ campaign }: { campaign: Campaign }): JSX.Element {
  const [sessions, setSessions] = useState<CampaignSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ title: '', start: '', agenda: '' });
  const [recapId, setRecapId] = useState<string | null>(null);
  const [recap, setRecap] = useState('');

  async function refresh(): Promise<void> {
    try {
      const s = await api<CampaignSession[]>(`/campaigns/${campaign.id}/sessions`);
      setSessions(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load sessions');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id]);

  async function create(): Promise<void> {
    if (!draft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateCampaignSessionRequest = {
        campaignId: campaign.id,
        title: draft.title.trim(),
        ...(draft.start ? { scheduledStart: new Date(draft.start).toISOString() } : {}),
        ...(draft.agenda.trim() ? { agenda: draft.agenda.trim() } : {}),
      };
      await api('/sessions', { method: 'POST', body });
      setDraft({ title: '', start: '', agenda: '' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create session');
    } finally {
      setBusy(false);
    }
  }

  async function rsvp(
    sessionId: string,
    status: 'yes' | 'no' | 'maybe' | 'late',
  ): Promise<void> {
    try {
      await api(`/sessions/${sessionId}/rsvp`, { method: 'PUT', body: { status } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'RSVP failed');
    }
  }

  async function saveRecap(sessionId: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: { recap, status: 'completed' },
      });
      setRecapId(null);
      setRecap('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save recap');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <div className="text-xs uppercase tracking-wider text-fg-muted">New session</div>
        <input
          className="input"
          placeholder="Title"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          disabled={busy}
        />
        <input
          type="datetime-local"
          className="input"
          value={draft.start}
          onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
          disabled={busy}
        />
        <textarea
          className="input min-h-[3rem]"
          placeholder="Agenda (optional)"
          value={draft.agenda}
          onChange={(e) => setDraft((d) => ({ ...d, agenda: e.target.value }))}
          disabled={busy}
        />
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={() => void create()}
            disabled={busy || !draft.title.trim()}
          >
            Add session
          </button>
        </div>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.id} className="card space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="font-serif font-medium">{s.title}</div>
                <div className="font-mono text-xs text-fg-muted">
                  {s.scheduledStart
                    ? new Date(s.scheduledStart).toLocaleString()
                    : 'unscheduled'}{' '}
                  · {s.status}
                </div>
              </div>
              <div className="flex gap-1 text-xs">
                {(['yes', 'maybe', 'no', 'late'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => void rsvp(s.id, v)}
                    className="rounded border border-subtle px-2 py-0.5 hover:bg-raised"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {s.agenda ? (
              <p className="rounded bg-canvas p-2 text-sm">{s.agenda}</p>
            ) : null}
            {s.recap ? (
              <p className="rounded bg-canvas p-2 text-sm italic text-fg">
                {s.recap}
              </p>
            ) : null}
            {recapId === s.id ? (
              <div className="space-y-2">
                <textarea
                  className="input min-h-[6rem]"
                  value={recap}
                  onChange={(e) => setRecap(e.target.value)}
                  placeholder="What happened?"
                  disabled={busy}
                />
                <div className="flex justify-end gap-2">
                  <button className="btn-ghost text-xs" onClick={() => setRecapId(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary text-xs"
                    onClick={() => void saveRecap(s.id)}
                    disabled={busy}
                  >
                    Save recap &amp; mark complete
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn-ghost self-start text-xs"
                onClick={() => {
                  setRecapId(s.id);
                  setRecap(s.recap ?? '');
                }}
              >
                {s.recap ? 'Edit recap' : 'Add recap'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
