import { useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface Props {
  serverId: string;
  userId: string;
  displayName: string;
  onClose: () => void;
  onApplied?: () => void;
}

const PRESETS: Array<{ label: string; seconds: number }> = [
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
];

export function TimeoutModal({ serverId, userId, displayName, onClose, onApplied }: Props): JSX.Element {
  const [preset, setPreset] = useState<number>(PRESETS[0]?.seconds ?? 3600);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const untilIso = new Date(Date.now() + preset * 1000).toISOString();
      await api(`/servers/${serverId}/members/${userId}/timeout`, {
        method: 'POST',
        body: { untilIso, reason: reason.trim() || undefined },
      });
      toast.info(`${displayName} timed out.`);
      onApplied?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not apply timeout');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-canvas/70" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded border border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <h2 className="font-serif text-lg">Timeout {displayName}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-raised" aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-fg-muted">
            They won’t be able to send messages, react, or attach files until the timeout lifts.
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.seconds}
                type="button"
                onClick={() => setPreset(p.seconds)}
                className={`rounded border px-3 py-1 ${
                  preset === p.seconds ? 'border-ember bg-tint-ember' : 'border-subtle hover:bg-raised'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="text-fg-muted">Reason (optional)</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="input mt-1 w-full"
              maxLength={280}
            />
          </label>
        </div>
        <footer className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} className="btn-primary" disabled={busy}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
