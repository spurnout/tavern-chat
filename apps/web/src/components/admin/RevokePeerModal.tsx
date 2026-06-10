import { useState } from 'react';
import { Modal } from '../Modal.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  peerHost: string;
  onConfirm: (reason?: string) => Promise<void>;
}

export function RevokePeerModal({ open, onOpenChange, peerHost, onConfirm }: Props): JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim() || undefined);
      setReason('');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke peer');
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(o: boolean): void {
    if (!busy) {
      if (!o) setReason('');
      onOpenChange(o);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title="Revoke peer"
      description={`Revoke peering with ${peerHost}? This will prevent all federated communication with this instance.`}
      footer={
        <>
          <button className="btn-ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-danger"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? 'Revoking…' : 'Revoke peer'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Reason (optional)</span>
        <input
          className="input"
          placeholder="Optional reason…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          disabled={busy}
        />
      </label>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
