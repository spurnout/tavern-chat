import { useState } from 'react';
import type { BoardGame, CreateGameNightRequest } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { Modal } from '../Modal.js';

export function CreateGameNightModal({
  serverId,
  games,
  open,
  onOpenChange,
  onCreated,
}: {
  serverId: string;
  games: BoardGame[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [location, setLocation] = useState('');
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCandidate(id: string): void {
    setCandidateIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: CreateGameNightRequest = {
        title: title.trim(),
        ...(start ? { scheduledStart: new Date(start).toISOString() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(candidateIds.length > 0 ? { candidateBoardGameIds: candidateIds } : {}),
      };
      await api(`/servers/${serverId}/game-nights`, { method: 'POST', body });
      onCreated();
      onOpenChange(false);
      setTitle('');
      setStart('');
      setLocation('');
      setCandidateIds([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Plan a game night"
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
          >
            {busy ? 'Saving…' : 'Plan'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">When</span>
        <input
          type="datetime-local"
          className="input"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Location (optional)</span>
        <input
          className="input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </label>
      {games.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-xs uppercase tracking-wider text-fg-muted">
            Candidate games
          </div>
          <ul className="grid grid-cols-2 gap-1 text-sm">
            {games.map((g) => (
              <li key={g.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 hover:bg-raised">
                  <input
                    type="checkbox"
                    checked={candidateIds.includes(g.id)}
                    onChange={() => toggleCandidate(g.id)}
                  />
                  <span className="truncate">{g.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
