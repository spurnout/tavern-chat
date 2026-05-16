import { useEffect, useMemo, useState } from 'react';
import type { Campaign, CampaignNote, NoteVisibility } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { MessageContent, slugifyWikiTarget } from '../MessageContent.js';

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
      <NoteList notes={notes} onDelete={(id) => void remove(id)} />
    </div>
  );
}

/**
 * Renders the campaign's notes with wikilink-aware markdown. Each list item
 * carries an `id` of the form `note-<slug>` so `[[Title]]` references from
 * other notes (or from the same note) resolve via in-page anchor scrolling.
 */
function NoteList({
  notes,
  onDelete,
}: {
  notes: CampaignNote[];
  onDelete: (id: string) => void;
}): JSX.Element {
  // Build a set of slugs that actually exist so we can hint at broken
  // references. Currently used only for the hover title; the visual treatment
  // is the same either way — clicking a missing wikilink just no-ops.
  const knownSlugs = useMemo(
    () => new Set(notes.map((n) => slugifyWikiTarget(n.title))),
    [notes],
  );
  return (
    <ul className="space-y-2">
      {notes.map((n) => {
        const slug = slugifyWikiTarget(n.title);
        return (
          <li id={`note-${slug}`} key={n.id} className="card space-y-1 scroll-mt-16">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-serif font-medium">
                {n.pinned ? '📌 ' : ''}
                {n.title}
              </div>
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <span>{n.visibility.replace(/_/g, ' ')}</span>
                <span
                  className="text-fg-faint"
                  title={
                    knownSlugs.has(slug)
                      ? `Other notes can reference this with [[${n.title}]]`
                      : ''
                  }
                  aria-hidden
                >
                  #{slug}
                </span>
                <button
                  type="button"
                  className="text-danger hover:underline"
                  onClick={() => onDelete(n.id)}
                >
                  delete
                </button>
              </div>
            </div>
            <div className="text-sm">
              <MessageContent content={n.body} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
