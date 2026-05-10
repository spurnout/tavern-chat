import { useState } from 'react';
import type { Channel, ChannelType } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { Modal } from './Modal.js';

interface Props {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TYPES: Array<{ value: ChannelType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'voice', label: 'Voice / video' },
  { value: 'category', label: 'Category' },
];

export function CreateChannelModal({ serverId, open, onOpenChange }: Props): JSX.Element {
  const [type, setType] = useState<ChannelType>('text');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upsertChannel = useRealtime((s) => s.upsertChannel);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const channel = await api<Channel>(`/servers/${serverId}/channels`, {
        method: 'POST',
        body: {
          type,
          name: name.trim(),
          topic: topic.trim() || undefined,
        },
      });
      upsertChannel(channel);
      onOpenChange(false);
      setName('');
      setTopic('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create channel');
    } finally {
      setBusy(false);
    }
  }

  const valid = name.trim().length >= 1;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create channel"
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !valid}>
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setType(t.value)}
            disabled={busy}
            className={`rounded border p-3 text-sm ${
              type === t.value
                ? 'border-tavern-ember bg-tavern-ember/10 text-tavern-mead'
                : 'border-tavern-oak text-tavern-mist hover:bg-tavern-oak'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className="mt-4 block text-sm">
        <span className="mb-1 inline-block text-tavern-mist">Name</span>
        <input
          autoFocus
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
          maxLength={64}
          disabled={busy}
        />
      </label>
      {type === 'text' ? (
        <label className="mt-3 block text-sm">
          <span className="mb-1 inline-block text-tavern-mist">Topic (optional)</span>
          <input
            className="input"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={1024}
            disabled={busy}
          />
        </label>
      ) : null}
      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
    </Modal>
  );
}
