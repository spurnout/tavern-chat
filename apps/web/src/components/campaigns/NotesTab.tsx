import { useEffect, useState } from 'react';
import type { Campaign, CampaignNote, NoteVisibility } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';

export function NotesTab({ campaign }: { campaign: Campaign }): JSX.Element {
  const [notes, setNotes] = useState<CampaignNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    body: '',
    visibility: 'public_to_party' as NoteVisibility,
    pinned: false,
  });

  async function refresh(): Promise<void> {
    try {
      const n = await api<CampaignNote[]>(`/campaigns/${campaign.id}/notes`);
      setNotes(n);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load notes');
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
      await api('/notes', {
        method: 'POST',
        body: { campaignId: campaign.id, ...draft, title: draft.title.trim() },
      });
      setDraft({ title: '', body: '', visibility: 'public_to_party', pinned: false });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save note');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete this note?')) return;
    try {
      await api(`/notes/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <div className="text-xs uppercase tracking-wider text-fg-muted">New note</div>
        <input
          className="input"
          placeholder="Title"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          disabled={busy}
        />
        <textarea
          className="input min-h-[6rem]"
          placeholder="Markdown supported on the receiving end"
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(e) => setDraft((d) => ({ ...d, pinned: e.target.checked }))}
              disabled={busy}
            />
            Pinned
          </label>
          <select
            className="input w-44"
            value={draft.visibility}
            onChange={(e) =>
              setDraft((d) => ({ ...d, visibility: e.target.value as NoteVisibility }))
            }
            disabled={busy}
          >
            <option value="public_to_party">Public to party</option>
            <option value="gm_only">GM only</option>
          </select>
          <button
            className="ml-auto btn-primary text-sm"
            onClick={() => void create()}
            disabled={busy || !draft.title.trim()}
          >
            Add note
          </button>
        </div>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="card space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-serif font-medium">
                {n.pinned ? '📌 ' : ''}
                {n.title}
              </div>
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <span>{n.visibility.replace(/_/g, ' ')}</span>
                <button
                  type="button"
                  className="text-danger hover:underline"
                  onClick={() => void remove(n.id)}
                >
                  delete
                </button>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-sm">{n.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
