import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Plus, Swords } from 'lucide-react';
import type {
  Campaign,
  CampaignNote,
  CampaignSession,
  CreateCampaignSessionRequest,
  Handout,
  HandoutVisibility,
  NoteVisibility,
} from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { CreateCampaignModal } from '../components/CreateCampaignModal.js';
import { uploadFile } from '../lib/uploads.js';

export function CampaignsPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (!serverId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api<Campaign[]>(`/servers/${serverId}/campaigns`);
      setCampaigns(list);
      if (!activeId && list[0]) setActiveId(list[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load campaigns');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const active = campaigns.find((c) => c.id === activeId) ?? null;

  if (!serverId) return <div className="p-12">Pick a server.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-tavern-oak px-4 py-3">
        <Swords size={16} className="text-tavern-mist" />
        <span className="font-semibold">Campaigns</span>
        <button
          type="button"
          className="btn-primary ml-auto text-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} className="mr-1" /> New campaign
        </button>
      </header>
      <div className="grid flex-1 grid-cols-1 gap-0 lg:grid-cols-[280px_1fr]">
        <aside className="border-b border-tavern-oak p-3 lg:border-b-0 lg:border-r">
          {loading ? <p className="text-tavern-mist">Loading…</p> : null}
          {error ? <p className="text-red-400">{error}</p> : null}
          {!loading && campaigns.length === 0 ? (
            <p className="text-sm text-tavern-mist">No campaigns yet.</p>
          ) : null}
          <ul className="space-y-1">
            {campaigns.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                    activeId === c.id ? 'bg-tavern-oak' : 'hover:bg-tavern-oak'
                  }`}
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-tavern-mist">
                    {c.gameSystem ?? '—'} · {c.status}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="overflow-y-auto p-6">
          {active ? <CampaignDetail campaign={active} /> : null}
        </main>
      </div>
      <CreateCampaignModal
        serverId={serverId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(c) => {
          setCampaigns((all) => [c, ...all]);
          setActiveId(c.id);
        }}
      />
    </div>
  );
}

function CampaignDetail({ campaign }: { campaign: Campaign }): JSX.Element {
  const [tab, setTab] = useState<'sessions' | 'notes' | 'handouts'>('sessions');
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-2xl font-semibold">{campaign.name}</h2>
        {campaign.description ? (
          <p className="mt-1 text-sm text-tavern-parchment">{campaign.description}</p>
        ) : null}
      </header>
      {campaign.safetyBoundaries.length > 0 ? (
        <div className="rounded border border-tavern-oak bg-tavern-stone p-3 text-xs">
          <div className="mb-1 uppercase tracking-wider text-tavern-mist">Safety lines &amp; veils</div>
          <ul className="space-y-0.5">
            {campaign.safetyBoundaries.map((b) => (
              <li key={b.topic}>
                <strong>{b.topic}:</strong>{' '}
                <span className="text-tavern-mist">{b.action.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-1 text-xs">
        <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
          Sessions
        </TabButton>
        <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>
          Notes
        </TabButton>
        <TabButton active={tab === 'handouts'} onClick={() => setTab('handouts')}>
          Handouts
        </TabButton>
      </div>
      {tab === 'sessions' ? <SessionsTab campaign={campaign} /> : null}
      {tab === 'notes' ? <NotesTab campaign={campaign} /> : null}
      {tab === 'handouts' ? <HandoutsTab campaign={campaign} /> : null}
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
        active ? 'bg-tavern-oak text-tavern-parchment' : 'text-tavern-mist hover:bg-tavern-oak'
      }`}
    >
      {children}
    </button>
  );
}

// ---- Sessions -------------------------------------------------------------

function SessionsTab({ campaign }: { campaign: Campaign }): JSX.Element {
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
        <div className="text-xs uppercase tracking-wider text-tavern-mist">New session</div>
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
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.id} className="card space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="font-semibold">{s.title}</div>
                <div className="text-xs text-tavern-mist">
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
                    className="rounded border border-tavern-oak px-2 py-0.5 hover:bg-tavern-oak"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {s.agenda ? (
              <p className="rounded bg-tavern-ink p-2 text-sm">{s.agenda}</p>
            ) : null}
            {s.recap ? (
              <p className="rounded bg-tavern-ink p-2 text-sm italic text-tavern-parchment">
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

// ---- Notes ----------------------------------------------------------------

function NotesTab({ campaign }: { campaign: Campaign }): JSX.Element {
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
        <div className="text-xs uppercase tracking-wider text-tavern-mist">New note</div>
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
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <ul className="space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="card space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-semibold">
                {n.pinned ? '📌 ' : ''}
                {n.title}
              </div>
              <div className="flex items-center gap-2 text-xs text-tavern-mist">
                <span>{n.visibility.replace(/_/g, ' ')}</span>
                <button
                  type="button"
                  className="text-red-300 hover:underline"
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

// ---- Handouts -------------------------------------------------------------

function HandoutsTab({ campaign }: { campaign: Campaign }): JSX.Element {
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
        <div className="text-xs uppercase tracking-wider text-tavern-mist">New handout</div>
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
            <span className="text-xs text-tavern-mist">
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
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <ul className="space-y-2">
        {handouts.map((h) => (
          <li key={h.id} className="card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-semibold">{h.title}</div>
              <span className="text-xs text-tavern-mist">{h.visibility.replace(/_/g, ' ')}</span>
            </div>
            {h.body ? <p className="whitespace-pre-wrap text-sm">{h.body}</p> : null}
            {h.attachmentIds.length > 0 ? (
              <div className="mt-1 text-xs text-tavern-mist">
                {h.attachmentIds.length} attachment{h.attachmentIds.length === 1 ? '' : 's'}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
