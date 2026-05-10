import { useState } from 'react';
import type { Campaign, SafetyBoundary, SafetyBoundaryAction } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { Modal } from './Modal.js';

interface Props {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (c: Campaign) => void;
}

const ACTIONS: SafetyBoundaryAction[] = [
  'allow',
  'fade_to_black',
  'content_warning',
  'requires_consent',
  'block',
];

export function CreateCampaignModal({
  serverId,
  open,
  onOpenChange,
  onCreated,
}: Props): JSX.Element {
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const [description, setDescription] = useState('');
  const [boundaries, setBoundaries] = useState<SafetyBoundary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addBoundary(): void {
    setBoundaries((b) => [...b, { topic: '', action: 'content_warning' }]);
  }
  function updateBoundary(i: number, patch: Partial<SafetyBoundary>): void {
    setBoundaries((b) => b.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeBoundary(i: number): void {
    setBoundaries((b) => b.filter((_, idx) => idx !== i));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const c = await api<Campaign>(`/servers/${serverId}/campaigns`, {
        method: 'POST',
        body: {
          name: name.trim(),
          gameSystem: system.trim() || undefined,
          description: description.trim() || undefined,
          safetyBoundaries: boundaries.filter((b) => b.topic.trim().length > 0),
        },
      });
      onCreated?.(c);
      onOpenChange(false);
      setName('');
      setSystem('');
      setDescription('');
      setBoundaries([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create campaign');
    } finally {
      setBusy(false);
    }
  }

  const valid = name.trim().length >= 2;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create campaign"
      description="You'll be the GM. Players take part by being members of this den."
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !valid}>
            {busy ? 'Creating…' : 'Create campaign'}
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
          disabled={busy}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Game system</span>
        <input
          className="input"
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          placeholder="e.g. D&D 5e, Blades in the Dark"
          maxLength={64}
          disabled={busy}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Description</span>
        <textarea
          className="input min-h-[5rem]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2048}
          disabled={busy}
        />
      </label>
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-fg-muted">
            Safety lines &amp; veils
          </span>
          <button type="button" className="btn-ghost text-xs" onClick={addBoundary} disabled={busy}>
            + add
          </button>
        </div>
        <ul className="space-y-2">
          {boundaries.map((b, i) => (
            <li key={i} className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="topic (e.g. romance)"
                value={b.topic}
                onChange={(e) => updateBoundary(i, { topic: e.target.value })}
                disabled={busy}
              />
              <select
                className="input w-44"
                value={b.action}
                onChange={(e) =>
                  updateBoundary(i, { action: e.target.value as SafetyBoundaryAction })
                }
                disabled={busy}
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-ghost text-danger"
                onClick={() => removeBoundary(i)}
                aria-label="Remove"
              >
                ×
              </button>
            </li>
          ))}
          {boundaries.length === 0 ? (
            <li className="text-xs text-fg-muted">
              You can add lines &amp; veils later from the campaign page.
            </li>
          ) : null}
        </ul>
      </div>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
