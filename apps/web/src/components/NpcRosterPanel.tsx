import { useCallback, useEffect, useState } from 'react';
import { Plus, Skull, Trash2, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { EmptyState } from './EmptyState.js';

interface Npc {
  id: string;
  campaignId: string;
  name: string;
  descriptionMd: string | null;
  factionTag: string | null;
  locationTag: string | null;
  isAlive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  campaignId: string;
}

export function NpcRosterPanel({ campaignId }: Props): JSX.Element {
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Npc | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await api<Npc[]>(`/campaigns/${campaignId}/npcs`);
      setNpcs(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load NPCs');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = npcs.filter((n) =>
    [n.name, n.factionTag ?? '', n.locationTag ?? '']
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  async function create(): Promise<void> {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const n = await api<Npc>(`/campaigns/${campaignId}/npcs`, {
        method: 'POST',
        body: { name: newName.trim() },
      });
      setNpcs((s) => [...s, n]);
      setNewName('');
      setActiveId(n.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create');
    } finally {
      setCreating(false);
    }
  }

  async function patch(id: string, patch: Partial<Npc>): Promise<void> {
    try {
      const r = await api<Npc>(`/npcs/${id}`, { method: 'PATCH', body: patch });
      setNpcs((s) => s.map((n) => (n.id === id ? r : n)));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/npcs/${id}`, { method: 'DELETE' });
      setNpcs((s) => s.filter((n) => n.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  const active = npcs.find((n) => n.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-subtle bg-sunken">
        <div className="space-y-2 p-3">
          <input
            type="text"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input w-full text-sm"
          />
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="New NPC"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="input flex-1 text-sm"
              maxLength={120}
            />
            <button
              type="button"
              onClick={() => void create()}
              className="btn-primary text-xs"
              disabled={creating || !newName.trim()}
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <ul className="text-sm">
          {loading ? (
            <li className="px-3 py-2 text-fg-muted">Loading…</li>
          ) : filtered.length === 0 ? (
            <li>
              <EmptyState
                icon={<Users size={28} strokeWidth={1.5} />}
                title={query ? 'No one by that name.' : 'No NPCs yet.'}
                description={
                  query
                    ? 'Try a different name, faction, or place.'
                    : 'Add the faces your party will meet — innkeepers, rivals, patrons, and the rest.'
                }
                className="px-4 py-8"
              />
            </li>
          ) : (
            filtered.map((n) => (
              <li
                key={n.id}
                className={`border-b border-subtle px-3 py-2 ${
                  activeId === n.id ? 'bg-raised' : 'hover:bg-raised/50'
                }`}
              >
                <button type="button" onClick={() => setActiveId(n.id)} className="block w-full text-left">
                  <div className="flex items-center gap-1 font-medium">
                    {!n.isAlive ? <Skull size={12} className="text-danger" /> : null}
                    {n.name}
                  </div>
                  {n.factionTag || n.locationTag ? (
                    <div className="text-xs text-fg-muted">
                      {[n.factionTag, n.locationTag].filter(Boolean).join(' · ')}
                    </div>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      <main className="flex-1 overflow-y-auto p-4">
        {active ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={active.name}
                onChange={(e) => void patch(active.id, { name: e.target.value })}
                className="input flex-1 font-serif text-lg"
                maxLength={120}
              />
              <button
                type="button"
                onClick={() => setPendingDelete(active)}
                className="rounded p-2 text-fg-muted hover:bg-raised hover:text-danger"
                aria-label="Delete NPC"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <label className="block">
                <span className="text-xs text-fg-muted">Faction</span>
                <input
                  type="text"
                  value={active.factionTag ?? ''}
                  onChange={(e) => void patch(active.id, { factionTag: e.target.value || null })}
                  className="input mt-1 w-full"
                  maxLength={40}
                />
              </label>
              <label className="block">
                <span className="text-xs text-fg-muted">Location</span>
                <input
                  type="text"
                  value={active.locationTag ?? ''}
                  onChange={(e) => void patch(active.id, { locationTag: e.target.value || null })}
                  className="input mt-1 w-full"
                  maxLength={40}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={active.isAlive}
                onChange={(e) => void patch(active.id, { isAlive: e.target.checked })}
              />
              Alive
            </label>
            <textarea
              value={active.descriptionMd ?? ''}
              onChange={(e) => void patch(active.id, { descriptionMd: e.target.value })}
              placeholder="Description / notes (markdown)"
              rows={12}
              className="input w-full resize-y font-mono text-xs"
            />
          </div>
        ) : (
          <p className="text-fg-muted">Select an NPC or create one.</p>
        )}
      </main>
      {pendingDelete ? (
        <ConfirmDialog
          title="Delete this NPC?"
          description={`Delete "${pendingDelete.name}"? This can't be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            const id = pendingDelete.id;
            setPendingDelete(null);
            await remove(id);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
