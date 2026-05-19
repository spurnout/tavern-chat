import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dice5, Plus, Swords, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useAuth } from '../lib/auth.js';
import { CharacterSheetDnD5e } from './CharacterSheetDnD5e.js';

interface Character {
  id: string;
  campaignId: string;
  ownerUserId: string;
  name: string;
  conceptOneLiner: string | null;
  system: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sheetJson: any;
}

interface MacroRow {
  id: string;
  characterId: string;
  label: string;
  notation: string;
  position: number;
  color: string | null;
}

interface Props {
  campaignId: string;
  /** Optional channel context — when set, macro rolls post into this channel. */
  channelId?: string | null;
}

/**
 * Tab content for the campaign page: list of characters + selected sheet
 * + macro panel. Mounted by `campaigns-page.tsx`.
 */
export function CharactersPanel({ campaignId, channelId }: Props): JSX.Element {
  const me = useAuth((s) => s.me);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await api<Character[]>(`/campaigns/${campaignId}/characters`);
      setCharacters(r);
      // Functional update so this callback doesn't capture `selectedId` —
      // capturing it would force a useCallback dep that re-runs the effect
      // every time the user picks a different character, which would refetch
      // the list pointlessly. With the functional form, the first refresh
      // seeds selection and subsequent ones leave the user's pick alone.
      setSelectedId((prev) => prev ?? r[0]?.id ?? null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load characters');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => characters.find((c) => c.id === selectedId) ?? null,
    [characters, selectedId],
  );
  const canEdit = !!selected && (selected.ownerUserId === me?.id);

  async function create(): Promise<void> {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const c = await api<Character>(`/campaigns/${campaignId}/characters`, {
        method: 'POST',
        body: { name: newName.trim(), system: 'dnd5e' },
      });
      setCharacters((s) => [...s, c]);
      setSelectedId(c.id);
      setNewName('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create');
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/characters/${id}`, { method: 'DELETE' });
      setCharacters((s) => s.filter((c) => c.id !== id));
      if (selectedId === id) {
        setSelectedId(characters[0]?.id ?? null);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-subtle bg-sunken">
        <div className="p-3">
          <h2 className="font-serif text-sm">Characters</h2>
          <div className="mt-2 flex gap-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New character name"
              className="input flex-1 text-sm"
              maxLength={80}
            />
            <button
              type="button"
              onClick={() => void create()}
              className="btn-primary text-xs"
              disabled={creating || !newName.trim()}
              title="Create character"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <ul className="text-sm">
          {loading ? (
            <li className="px-3 py-2 text-fg-muted">Loading…</li>
          ) : characters.length === 0 ? (
            <li className="px-3 py-2 text-fg-muted">No characters yet.</li>
          ) : (
            characters.map((c) => (
              <li
                key={c.id}
                className={`flex items-center gap-2 border-b border-subtle px-3 py-2 ${
                  selectedId === c.id ? 'bg-raised' : 'hover:bg-raised/50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="flex-1 text-left"
                >
                  <div className="font-medium">{c.name}</div>
                  {c.conceptOneLiner ? (
                    <div className="text-xs text-fg-muted">{c.conceptOneLiner}</div>
                  ) : null}
                </button>
                {c.ownerUserId === me?.id ? (
                  <button
                    type="button"
                    onClick={() => void remove(c.id)}
                    className="rounded p-1 text-fg-muted hover:bg-raised"
                    aria-label="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </aside>
      <main className="flex-1 overflow-y-auto p-4">
        {selected ? (
          <>
            <CharacterSheetDnD5e
              character={selected}
              canEdit={canEdit}
              onUpdated={(c) => {
                setCharacters((s) => s.map((x) => (x.id === c.id ? c : x)));
              }}
            />
            <MacrosPanel character={selected} canEdit={canEdit} channelId={channelId ?? null} />
          </>
        ) : (
          <p className="text-fg-muted">Select a character or create one.</p>
        )}
      </main>
    </div>
  );
}

function MacrosPanel({
  character,
  canEdit,
  channelId,
}: {
  character: Character;
  canEdit: boolean;
  channelId: string | null;
}): JSX.Element {
  const [macros, setMacros] = useState<MacroRow[]>([]);
  const [label, setLabel] = useState('');
  const [notation, setNotation] = useState('1d20+5');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<MacroRow[]>(`/characters/${character.id}/macros`);
      setMacros(r);
    } catch {
      // silent
    }
  }, [character.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(): Promise<void> {
    if (!label.trim() || !notation.trim()) return;
    try {
      await api(`/characters/${character.id}/macros`, {
        method: 'POST',
        body: { label: label.trim(), notation: notation.trim() },
      });
      setLabel('');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create macro');
    }
  }

  async function fire(m: MacroRow): Promise<void> {
    if (!channelId) {
      toast.error('Open a room to fire macros into.');
      return;
    }
    try {
      await api(`/dice/roll`, {
        method: 'POST',
        body: { channelId, notation: m.notation, label: m.label, visibility: 'public' },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Roll failed');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/macros/${id}`, { method: 'DELETE' });
      setMacros((s) => s.filter((m) => m.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  return (
    <section className="mt-4 rounded border border-subtle bg-surface p-4">
      <h3 className="flex items-center gap-2 font-serif text-sm">
        <Swords size={14} /> Macros
      </h3>
      <p className="mt-1 text-xs text-fg-muted">
        One-click rolls. Fires into the currently open room.
      </p>
      <ul className="mt-3 flex flex-wrap gap-1">
        {macros.map((m) => (
          <li key={m.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void fire(m)}
              className="inline-flex items-center gap-1 rounded border border-subtle bg-canvas px-2 py-1 text-xs hover:bg-raised"
              title={m.notation}
            >
              <Dice5 size={12} /> {m.label}
            </button>
            {canEdit ? (
              <button
                type="button"
                onClick={() => void remove(m.id)}
                className="rounded p-1 text-fg-muted hover:bg-raised"
                aria-label="Delete macro"
              >
                <Trash2 size={10} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <label className="block">
            <span className="text-xs text-fg-muted">Label</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="input mt-1 w-40 text-sm"
              maxLength={60}
            />
          </label>
          <label className="block">
            <span className="text-xs text-fg-muted">Notation</span>
            <input
              type="text"
              value={notation}
              onChange={(e) => setNotation(e.target.value)}
              className="input mt-1 w-32 font-mono text-sm"
              maxLength={200}
            />
          </label>
          <button type="button" className="btn-primary text-xs" onClick={() => void create()}>
            Add macro
          </button>
        </div>
      ) : null}
    </section>
  );
}
