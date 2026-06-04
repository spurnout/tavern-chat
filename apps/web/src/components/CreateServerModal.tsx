import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Server } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { Modal } from './Modal.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateServerModal({ open, onOpenChange }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upsertServer = useRealtime((s) => s.upsertServer);
  const navigate = useNavigate();

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const server = await api<Server>('/servers', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || undefined },
      });
      upsertServer(server);
      onOpenChange(false);
      setName('');
      setDescription('');
      await navigate({ to: '/app/servers/$serverId', params: { serverId: server.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create tavern');
    } finally {
      setBusy(false);
    }
  }

  const valid = name.trim().length >= 2;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create a new tavern"
      description="Taverns are private spaces with their own rooms, roles, and members."
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy || !valid}
          >
            {busy ? 'Creating…' : 'Create tavern'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Name</span>
        <input
          autoFocus
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          minLength={2}
          disabled={busy}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Description (optional)</span>
        <textarea
          className="input min-h-[5rem]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2048}
          disabled={busy}
        />
      </label>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
