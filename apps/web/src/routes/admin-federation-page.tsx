import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api-client.js';
import { PeersTable, type PeerRow } from '../components/admin/PeersTable.js';
import { AddPeerModal } from '../components/admin/AddPeerModal.js';
import { RevokePeerModal } from '../components/admin/RevokePeerModal.js';

interface FailedJob {
  id: string;
  eventType: string;
  peerInstanceId: string;
  failedReason: string;
  failedAt: string | null;
  attemptsMade: number;
}

export function AdminFederationPage(): JSX.Element {
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<PeerRow | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [peersRes, deadLettersRes] = await Promise.all([
        api<{ peers: PeerRow[] }>('/admin/peers'),
        api<{ jobs: FailedJob[] }>('/admin/federation/dead-letters'),
      ]);
      setPeers(peersRes.peers);
      setFailedJobs(deadLettersRes.jobs);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load federation data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function approve(id: string): Promise<void> {
    await api(`/admin/peers/${id}/approve`, { method: 'POST' });
    await refresh();
  }
  function revoke(id: string): void {
    const peer = peers.find((p) => p.id === id) ?? null;
    setPendingRevoke(peer);
  }

  async function confirmRevoke(reason?: string): Promise<void> {
    if (!pendingRevoke) return;
    await api(`/admin/peers/${pendingRevoke.id}`, { method: 'DELETE', body: { reason } });
    setPendingRevoke(null);
    await refresh();
  }

  async function retryJob(id: string): Promise<void> {
    try {
      await api(`/admin/federation/dead-letters/${id}/retry`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to retry job');
    }
  }
  async function discardJob(id: string): Promise<void> {
    try {
      await api(`/admin/federation/dead-letters/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to discard job');
    }
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
      <RevokePeerModal
        open={pendingRevoke !== null}
        onOpenChange={(o) => { if (!o) setPendingRevoke(null); }}
        peerHost={pendingRevoke?.host ?? ''}
        onConfirm={confirmRevoke}
      />

      <section className="mt-8">
        <h2 className="mb-1 font-serif text-xl">Failed outbox jobs</h2>
        <p className="mb-4 text-sm text-fg-muted">
          Federation events that exhausted all delivery attempts. Retry to re-queue or discard to remove.
        </p>
        <div className="bg-surface border border-subtle rounded p-6">
          {loading ? (
            <p className="text-sm text-fg-muted">Loading…</p>
          ) : failedJobs.length === 0 ? (
            <p className="text-sm text-fg-muted">No failed jobs</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-subtle text-left text-fg-muted">
                  <th className="pb-2 pr-4 font-medium">Event type</th>
                  <th className="pb-2 pr-4 font-medium">Peer</th>
                  <th className="pb-2 pr-4 font-medium">Failed at</th>
                  <th className="pb-2 pr-4 font-medium">Error</th>
                  <th className="pb-2 pr-4 font-medium">Attempts</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {failedJobs.map((job) => (
                  <tr key={job.id} className="border-b border-subtle last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{job.eventType}</td>
                    <td className="py-2 pr-4">{job.peerInstanceId}</td>
                    <td className="py-2 pr-4 text-fg-muted">
                      {job.failedAt ? new Date(job.failedAt).toLocaleString() : '—'}
                    </td>
                    <td className="py-2 pr-4 max-w-xs truncate text-fg-muted" title={job.failedReason}>
                      {job.failedReason}
                    </td>
                    <td className="py-2 pr-4 text-center">{job.attemptsMade}</td>
                    <td className="py-2 space-x-2">
                      <button
                        className="text-xs text-ember hover:underline"
                        onClick={() => void retryJob(job.id)}
                      >
                        Retry
                      </button>
                      <button
                        className="text-xs text-fg-muted hover:text-danger hover:underline"
                        onClick={() => void discardJob(job.id)}
                      >
                        Discard
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
