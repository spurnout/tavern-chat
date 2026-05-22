export interface PeerRow {
  id: string;
  host: string;
  status: 'pending_inbound' | 'pending_outbound' | 'peered' | 'revoked' | 'blocked';
  capabilities: string[];
  peeredAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  contactEmail: string | null;
  createdAt: string;
  keyFingerprint: string | null;
}

interface Props {
  peers: PeerRow[];
  onApprove: (id: string) => void | Promise<void>;
  onRevoke: (id: string) => void | Promise<void>;
}

const STATUS_LABEL: Record<PeerRow['status'], { text: string; cls: string }> = {
  pending_inbound: { text: 'Awaiting your approval', cls: 'bg-tint-ember text-fg' },
  pending_outbound: { text: 'Sent — waiting on peer', cls: 'bg-raised text-fg-muted' },
  peered: { text: 'Peered', cls: 'bg-tint-good text-fg' },
  revoked: { text: 'Revoked', cls: 'bg-raised text-fg-muted' },
  blocked: { text: 'Blocked', cls: 'bg-tint-bad text-fg' },
};

export function PeersTable({ peers, onApprove, onRevoke }: Props): JSX.Element {
  if (peers.length === 0) {
    return <p className="rounded border border-subtle bg-surface p-6 text-sm text-fg-muted">No peers yet. Add one to start.</p>;
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-subtle text-left text-fg-muted">
          <th className="py-2">Host</th>
          <th className="py-2">Status</th>
          <th className="py-2">Capabilities</th>
          <th className="py-2">Fingerprint</th>
          <th className="py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {peers.map((p) => {
          const label = STATUS_LABEL[p.status];
          return (
            <tr key={p.id} className="border-b border-subtle">
              <td className="py-3">
                <div className="font-medium">{p.host}</div>
                {p.contactEmail ? <div className="text-xs text-fg-muted">{p.contactEmail}</div> : null}
              </td>
              <td className="py-3">
                <span className={`inline-block rounded px-2 py-0.5 text-xs ${label.cls}`}>{label.text}</span>
              </td>
              <td className="py-3">
                <div className="flex flex-wrap gap-1">
                  {p.capabilities.map((c) => (
                    <span key={c} className="rounded bg-raised px-1.5 py-0.5 text-xs text-fg-muted">{c}</span>
                  ))}
                </div>
              </td>
              <td className="py-3">
                {p.keyFingerprint
                  ? <code className="font-mono text-sm">{p.keyFingerprint}</code>
                  : <span className="text-fg-muted">—</span>}
              </td>
              <td className="py-3 text-right">
                {p.status === 'pending_inbound' ? (
                  <button className="btn-primary" onClick={() => void onApprove(p.id)}>Approve</button>
                ) : null}
                {p.status === 'peered' || p.status === 'pending_outbound' ? (
                  <button className="btn-ghost" onClick={() => void onRevoke(p.id)}>Revoke</button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
