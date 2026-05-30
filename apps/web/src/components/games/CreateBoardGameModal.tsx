import { useState } from 'react';
import type { CreateBoardGameRequest } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { Modal } from '../Modal.js';

export function CreateBoardGameModal({
  serverId,
  open,
  onOpenChange,
  onCreated,
}: {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [minPlayers, setMinPlayers] = useState(2);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [playTime, setPlayTime] = useState<number | ''>('');
  const [complexity, setComplexity] = useState<number | ''>('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: CreateBoardGameRequest = {
        name: name.trim(),
        description: description.trim() || undefined,
        minPlayers,
        maxPlayers,
        ...(typeof playTime === 'number' ? { playTimeMinutes: playTime } : {}),
        ...(typeof complexity === 'number' ? { complexity } : {}),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      };
      await api(`/servers/${serverId}/board-games`, { method: 'POST', body });
      onCreated();
      onOpenChange(false);
      setName('');
      setDescription('');
      setTags('');
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
      title="Add a game"
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Saving…' : 'Add'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Description</span>
        <textarea
          className="input min-h-[4rem]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <label>
          <span className="mb-1 inline-block text-fg-muted">Min players</span>
          <input
            type="number"
            min={1}
            max={20}
            className="input"
            value={minPlayers}
            onChange={(e) => setMinPlayers(Number(e.target.value))}
          />
        </label>
        <label>
          <span className="mb-1 inline-block text-fg-muted">Max players</span>
          <input
            type="number"
            min={1}
            max={20}
            className="input"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(Number(e.target.value))}
          />
        </label>
        <label>
          <span className="mb-1 inline-block text-fg-muted">Minutes</span>
          <input
            type="number"
            min={5}
            step={5}
            className="input"
            value={playTime}
            onChange={(e) => setPlayTime(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
        <label>
          <span className="mb-1 inline-block text-fg-muted">Complexity (1–5)</span>
          <input
            type="number"
            min={1}
            max={5}
            step={0.1}
            className="input"
            value={complexity}
            onChange={(e) => setComplexity(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Tags (comma-separated)</span>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
