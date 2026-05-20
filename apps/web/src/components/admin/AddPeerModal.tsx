import { useState } from 'react';
import { api, ApiError } from '../../lib/api-client.js';
import { Modal } from '../Modal.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddPeerModal({ open, onOpenChange }: Props): JSX.Element {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/admin/peers', { method: 'POST', body: { host: host.trim() } });
      setHost('');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add peer');
    } finally {
      setBusy(false);
    }
  }

  const valid = host.trim().length > 0 && host.includes('.');

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a peer"
      description="Peering is mutual. The other operator must also approve before content can flow."
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !valid}>
            {busy ? 'Sending…' : 'Send peering request'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Peer host</span>
        <input
          autoFocus
          className="input"
          placeholder="b.example.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          disabled={busy}
        />
      </label>
      <p className="mt-3 rounded border border-subtle bg-sunken p-3 text-xs text-fg-muted">
        Peering shares any future federated content with this host. It can be revoked, but content already sent cannot be recalled.
      </p>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
