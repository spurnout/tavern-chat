import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api-client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
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

function formatEventType(eventType: string): string {
  return eventType
    .replace(/[_.:-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortPeerId(peerInstanceId: string): string {
  if (peerInstanceId.length <= 24) return peerInstanceId;
  return `${peerInstanceId.slice(0, 10)}...${peerInstanceId.slice(-8)}`;
}

function formatFailedAt(failedAt: string | null): string {
  if (!failedAt) return 'Unknown time';
  return new Date(failedAt).toLocaleString();
}

export function AdminFederationPage(): JSX.Element {
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<PeerRow | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<FailedJob | null>(null);

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

  useEffect(() => {
    void refresh();
  }, []);

  async function approve(id: string): Promise<void> {
    try {
      await api(`/admin/peers/${id}/approve`, { method: 'POST' });
      await refresh();
    } catch (e) {
      // Surface failure rather than silently swallow — admin needs to know
      // a 403 / 5xx happened. `revoke` and the dead-letter actions already
      // have try/catch around their api() calls; this one was the odd
      // exception.
      setError(e instanceof ApiError ? e.message : 'Could not approve peer');
    }
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
    // The shell clips overflow at the viewport, so this page must scroll
    // itself — same pattern as the other settings-style pages.
    <div className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="font-serif text-2xl">Federation peers</h1>
            <p className="text-sm text-fg-muted">
              Trusted instances that can exchange content with this Tavern. Peering is mutual and
              revocable.
            </p>
          </div>
          <button className="btn-primary" onClick={() => setAddOpen(true)}>
            Add peer
          </button>
        </header>
        {error ? <p className="mb-3 text-sm text-danger">{error}</p> : null}
        {loading ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : (
          <PeersTable peers={peers} onApprove={approve} onRevoke={revoke} />
        )}
        <AddPeerModal
          open={addOpen}
          onOpenChange={(o) => {
            setAddOpen(o);
            if (!o) void refresh();
          }}
        />
        <RevokePeerModal
          open={pendingRevoke !== null}
          onOpenChange={(o) => {
            if (!o) setPendingRevoke(null);
          }}
          peerHost={pendingRevoke?.host ?? ''}
          onConfirm={confirmRevoke}
        />

        <section className="mt-8">
          <h2 className="mb-1 font-serif text-xl">Failed outbox jobs</h2>
          <p className="mb-4 text-sm text-fg-muted">
            Federation events that exhausted all delivery attempts. Retry to re-queue or discard to
            remove.
          </p>
          <div className="rounded border border-subtle bg-surface p-6">
            {loading ? (
              <p className="text-sm text-fg-muted">Loading…</p>
            ) : failedJobs.length === 0 ? (
              <p className="text-sm text-fg-muted">No failed jobs</p>
            ) : (
              <ul className="space-y-3">
                {failedJobs.map((job) => (
                  <li key={job.id} className="rounded border border-subtle bg-canvas p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-tint-rust px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-rust">
                            Delivery failed
                          </span>
                          <h3 className="font-serif text-base">
                            {formatEventType(job.eventType)}
                          </h3>
                        </div>
                        <p className="mt-1 text-sm text-fg-muted">
                          Peer{' '}
                          <span className="font-mono" title={job.peerInstanceId}>
                            {shortPeerId(job.peerInstanceId)}
                          </span>
                        </p>
                      </div>
                      <dl className="grid gap-1 text-right text-xs text-fg-muted">
                        <div>
                          <dt className="inline">Failed </dt>
                          <dd className="inline text-fg">{formatFailedAt(job.failedAt)}</dd>
                        </div>
                        <div>
                          <dt className="inline">Attempts </dt>
                          <dd className="inline text-fg">{job.attemptsMade}</dd>
                        </div>
                      </dl>
                    </div>
                    <p
                      className="mt-3 rounded border border-subtle bg-sunken px-3 py-2 text-sm text-fg-muted break-words"
                      title={job.failedReason}
                    >
                      {job.failedReason}
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        className="btn-primary text-xs"
                        onClick={() => void retryJob(job.id)}
                      >
                        Retry
                      </button>
                      <button
                        className="btn-ghost text-xs text-danger"
                        onClick={() => setPendingDiscard(job)}
                      >
                        Discard
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {pendingDiscard ? (
          <ConfirmDialog
            title="Discard this failed event?"
            description="This permanently drops a federation event that could otherwise be retried. Once discarded it cannot be recovered or re-queued."
            confirmLabel="Discard"
            destructive
            onCancel={() => setPendingDiscard(null)}
            onConfirm={async () => {
              const id = pendingDiscard.id;
              setPendingDiscard(null);
              await discardJob(id);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
