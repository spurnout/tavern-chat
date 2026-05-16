import { useEffect, useState } from 'react';
import { Plus, Skull, Sword, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface Participant {
  id: string;
  name: string;
  initiative: number;
  hp: number;
  maxHp: number;
  conditions: string[];
  isPc: boolean;
  position: number;
  hidden: boolean;
}

interface Encounter {
  id: string;
  channelId: string;
  campaignId: string | null;
  createdBy: string;
  status: 'setup' | 'running' | 'ended';
  currentTurnIndex: number;
  round: number;
  name: string | null;
  startedAt: string | null;
  endedAt: string | null;
  participants: Participant[];
}

interface Props {
  channelId: string;
}

/**
 * Initiative tracker for a channel. Top-of-room collapsible widget. Anyone
 * in the room sees the state; only members with MANAGE_SESSIONS (GMs) can
 * edit. The server enforces; the client just hides controls when 403s are
 * likely.
 */
export function EncounterPanel({ channelId }: Props): JSX.Element | null {
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [open, setOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Encounter | null>(`/channels/${channelId}/encounter`)
      .then((e) => {
        if (!cancelled) setEncounter(e);
      })
      .catch(() => {
        if (!cancelled) setEncounter(null);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  async function nextTurn(): Promise<void> {
    if (!encounter) return;
    try {
      const e = await api<Encounter>(`/encounters/${encounter.id}/next-turn`, { method: 'POST' });
      setEncounter(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not advance turn');
    }
  }

  async function startEncounter(): Promise<void> {
    if (!encounter) return;
    try {
      const e = await api<Encounter>(`/encounters/${encounter.id}/start`, { method: 'POST' });
      setEncounter(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start');
    }
  }

  async function endEncounter(): Promise<void> {
    if (!encounter) return;
    try {
      const e = await api<Encounter>(`/encounters/${encounter.id}/end`, { method: 'POST' });
      setEncounter(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not end');
    }
  }

  async function patchParticipant(pid: string, patch: Partial<Participant>): Promise<void> {
    if (!encounter) return;
    try {
      const e = await api<Encounter>(`/encounters/${encounter.id}/participants/${pid}`, {
        method: 'PATCH',
        body: patch,
      });
      setEncounter(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update');
    }
  }

  async function removeParticipant(pid: string): Promise<void> {
    if (!encounter) return;
    try {
      const e = await api<Encounter>(`/encounters/${encounter.id}/participants/${pid}`, {
        method: 'DELETE',
      });
      setEncounter(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove');
    }
  }

  async function addParticipant(input: {
    name: string;
    initiative: number;
    hp: number;
    maxHp: number;
    isPc: boolean;
  }): Promise<void> {
    if (!encounter) return;
    try {
      const e = await api<Encounter>(`/encounters/${encounter.id}/participants`, {
        method: 'POST',
        body: input,
      });
      setEncounter(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add');
    }
  }

  if (!encounter && !showCreate) {
    return (
      <div className="border-b border-subtle bg-sunken px-3 py-2 text-xs text-fg-muted">
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-raised"
        >
          <Sword size={12} /> Start an encounter (GM)
        </button>
      </div>
    );
  }
  if (!encounter && showCreate) {
    return <CreateEncounterCard channelId={channelId} onCreated={setEncounter} onCancel={() => setShowCreate(false)} />;
  }
  if (!encounter) return null;
  if (encounter.status === 'ended') return null;

  return (
    <aside className="border-b border-subtle bg-sunken">
      <header className="flex items-center gap-2 px-3 py-2 text-sm">
        <Sword size={14} className="text-mead" />
        <span className="font-serif font-medium">
          {encounter.name ?? 'Encounter'} — Round {encounter.round}
        </span>
        <span className="font-mono text-xs text-fg-muted">{encounter.status}</span>
        <div className="ml-auto flex items-center gap-1">
          {encounter.status === 'setup' ? (
            <button type="button" onClick={() => void startEncounter()} className="btn-primary text-xs">
              Start
            </button>
          ) : (
            <button type="button" onClick={() => void nextTurn()} className="btn-primary text-xs">
              Next turn
            </button>
          )}
          <button type="button" onClick={() => void endEncounter()} className="btn-ghost text-xs" title="End encounter">
            End
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded p-1 hover:bg-raised"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <X size={12} /> : <Plus size={12} />}
          </button>
        </div>
      </header>
      {open ? (
        <>
          <ul className="border-t border-subtle">
            {encounter.participants.map((p, idx) => (
              <li
                key={p.id}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${
                  idx === encounter.currentTurnIndex && encounter.status === 'running'
                    ? 'bg-tint-ember'
                    : ''
                }`}
              >
                <span className="w-8 font-mono text-xs text-fg-muted">{p.position + 1}.</span>
                <input
                  type="text"
                  value={p.name}
                  onChange={(e) => void patchParticipant(p.id, { name: e.target.value })}
                  className="input w-32 text-sm"
                />
                <label className="text-xs text-fg-muted">
                  init
                  <input
                    type="number"
                    value={p.initiative}
                    onChange={(e) =>
                      void patchParticipant(p.id, { initiative: Number(e.target.value) || 0 })
                    }
                    className="input ml-1 w-14 text-sm"
                  />
                </label>
                <label className="text-xs text-fg-muted">
                  hp
                  <input
                    type="number"
                    value={p.hp}
                    onChange={(e) =>
                      void patchParticipant(p.id, { hp: Number(e.target.value) || 0 })
                    }
                    className="input ml-1 w-16 text-sm"
                  />
                  /
                  <input
                    type="number"
                    value={p.maxHp}
                    onChange={(e) =>
                      void patchParticipant(p.id, { maxHp: Number(e.target.value) || 0 })
                    }
                    className="input ml-1 w-16 text-sm"
                  />
                </label>
                {p.hp <= 0 ? <Skull size={14} className="text-danger" /> : null}
                {p.isPc ? <span className="font-mono text-xs text-mead">PC</span> : null}
                <button
                  type="button"
                  onClick={() => void removeParticipant(p.id)}
                  className="ml-auto rounded p-1 text-fg-muted hover:bg-raised"
                  aria-label="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
          <AddParticipantRow onAdd={addParticipant} />
        </>
      ) : null}
    </aside>
  );
}

function AddParticipantRow({
  onAdd,
}: {
  onAdd: (p: {
    name: string;
    initiative: number;
    hp: number;
    maxHp: number;
    isPc: boolean;
  }) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [initiative, setInitiative] = useState(0);
  const [hp, setHp] = useState(0);
  const [maxHp, setMaxHp] = useState(0);
  const [isPc, setIsPc] = useState(false);

  function reset(): void {
    setName('');
    setInitiative(0);
    setHp(0);
    setMaxHp(0);
    setIsPc(false);
  }

  return (
    <div className="flex items-center gap-2 border-t border-subtle px-3 py-2 text-sm">
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="input w-32"
      />
      <input
        type="number"
        placeholder="init"
        value={initiative}
        onChange={(e) => setInitiative(Number(e.target.value) || 0)}
        className="input w-14"
      />
      <input
        type="number"
        placeholder="hp"
        value={hp}
        onChange={(e) => setHp(Number(e.target.value) || 0)}
        className="input w-16"
      />
      <input
        type="number"
        placeholder="max"
        value={maxHp}
        onChange={(e) => setMaxHp(Number(e.target.value) || 0)}
        className="input w-16"
      />
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        <input type="checkbox" checked={isPc} onChange={(e) => setIsPc(e.target.checked)} />
        PC
      </label>
      <button
        type="button"
        onClick={async () => {
          if (!name.trim()) return;
          await onAdd({ name: name.trim(), initiative, hp, maxHp, isPc });
          reset();
        }}
        className="btn-ghost text-xs"
        disabled={!name.trim()}
      >
        Add
      </button>
    </div>
  );
}

function CreateEncounterCard({
  channelId,
  onCreated,
  onCancel,
}: {
  channelId: string;
  onCreated: (e: Encounter) => void;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const e = await api<Encounter>(`/channels/${channelId}/encounters`, {
        method: 'POST',
        body: { name: name.trim() || null, participants: [] },
      });
      onCreated(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start an encounter');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-subtle bg-sunken px-3 py-2 text-sm">
      <input
        type="text"
        placeholder="Encounter name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="input flex-1"
      />
      <button type="button" className="btn-primary text-xs" onClick={() => void submit()} disabled={busy}>
        Create
      </button>
      <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
