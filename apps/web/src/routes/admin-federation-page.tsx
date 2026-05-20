import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api-client.js';
import { PeersTable, type PeerRow } from '../components/admin/PeersTable.js';
import { AddPeerModal } from '../components/admin/AddPeerModal.js';

export function AdminFederationPage(): JSX.Element {
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ peers: PeerRow[] }>('/admin/peers');
      setPeers(r.peers);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load peers');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function approve(id: string): Promise<void> {
    await api(`/admin/peers/${id}/approve`, { method: 'POST' });
    await refresh();
  }
  async function revoke(id: string): Promise<void> {
    const reason = window.prompt('Revoke this peer? Optional reason:') ?? undefined;
    if (reason === undefined) return; // cancelled
    await api(`/admin/peers/${id}`, { method: 'DELETE', body: { reason: reason || undefined } });
    await refresh();
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-serif text-2xl">Federation peers</h1>
          <p className="text-sm text-fg-muted">
            Trusted instances that can exchange content with this Tavern. Peering is mutual and revocable.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAddOpen(true)}>Add peer</button>
      </header>
      {error ? <p className="mb-3 text-sm text-danger">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <PeersTable peers={peers} onApprove={approve} onRevoke={revoke} />
      )}
      <AddPeerModal
        open={addOpen}
        onOpenChange={(o) => { setAddOpen(o); if (!o) void refresh(); }}
      />
    </div>
  );
}
