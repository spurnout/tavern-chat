import { useEffect, useState } from 'react';
import type { Campaign, Handout, HandoutVisibility } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { uploadFile } from '../../lib/uploads.js';

export function HandoutsTab({ campaign }: { campaign: Campaign }): JSX.Element {
  const [handouts, setHandouts] = useState<Handout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    body: '',
    visibility: 'public_to_party' as HandoutVisibility,
    attachmentIds: [] as string[],
  });

  async function refresh(): Promise<void> {
    try {
      const h = await api<Handout[]>(`/campaigns/${campaign.id}/handouts`);
      setHandouts(h);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load handouts');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const att = await uploadFile({ file, kind: 'handout' });
      setDraft((d) => ({ ...d, attachmentIds: [...d.attachmentIds, att.id] }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (!draft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api('/handouts', {
        method: 'POST',
        body: {
          campaignId: campaign.id,
          title: draft.title.trim(),
          body: draft.body,
          visibility: draft.visibility,
          attachmentIds: draft.attachmentIds,
        },
      });
      setDraft({ title: '', body: '', visibility: 'public_to_party', attachmentIds: [] });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save handout');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <div className="text-xs uppercase tracking-wider text-fg-muted">New handout</div>
        <input
          className="input"
          placeholder="Title"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          disabled={busy}
        />
        <textarea
          className="input min-h-[6rem]"
          placeholder="Body / lore"
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="cursor-pointer">
            <input
              type="file"
              className="hidden"
              accept="image/*,application/pdf"
              onChange={(e) => void onUpload(e)}
              disabled={busy}
            />
            <span className="btn-ghost">Attach file</span>
          </label>
          {draft.attachmentIds.length > 0 ? (
            <span className="text-xs text-fg-muted">
              {draft.attachmentIds.length} file{draft.attachmentIds.length === 1 ? '' : 's'}
            </span>
          ) : null}
          <select
            className="input ml-auto w-48"
            value={draft.visibility}
            onChange={(e) =>
              setDraft((d) => ({ ...d, visibility: e.target.value as HandoutVisibility }))
            }
            disabled={busy}
          >
            <option value="public_to_party">Public to party</option>
            <option value="gm_only">GM only</option>
            <option value="specific_players">Specific players</option>
          </select>
          <button
            className="btn-primary text-sm"
            onClick={() => void create()}
            disabled={busy || !draft.title.trim()}
          >
            Add handout
          </button>
        </div>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-2">
        {handouts.map((h) => (
          <li key={h.id} className="card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-serif font-medium">{h.title}</div>
              <span className="text-xs text-fg-muted">{h.visibility.replace(/_/g, ' ')}</span>
            </div>
            {h.body ? <p className="whitespace-pre-wrap text-sm">{h.body}</p> : null}
            {h.attachmentIds.length > 0 ? (
              <div className="mt-1 text-xs text-fg-muted">
                {h.attachmentIds.length} attachment{h.attachmentIds.length === 1 ? '' : 's'}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
