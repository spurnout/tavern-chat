import { useCallback, useEffect, useState } from 'react';
import { Copy, DoorOpen, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Server-scoped invite management. Lists existing invite codes, lets
 * anyone with CREATE_INVITES mint a new one, and lets MANAGE_SERVER
 * holders revoke them. The API already gates both — this panel just
 * surfaces whichever actions the API would have accepted, and reflects
 * 403s as toasts when the user lacks permission.
 *
 * No realtime hookup yet: the panel refetches on mount and mutates its
 * own local state after each action. If another admin revokes in
 * parallel, the user sees a stale row until they reopen the tab — an
 * acceptable trade for not threading INVITE_REVOKE through the gateway
 * for what is effectively a low-frequency admin surface.
 */

interface InviteRow {
  id: string;
  code: string;
  scope: 'instance' | 'server';
  serverId: string | null;
  channelId: string | null;
  createdById: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  remoteScope: string | null;
  remoteInstanceHost: string | null;
  remoteUserId: string | null;
  createdBy: { id: string; username: string; displayName: string } | null;
}

interface Props {
  serverId: string;
}

const EXPIRY_OPTIONS: { label: string; seconds: number }[] = [
  { label: '30 minutes', seconds: 60 * 30 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 60 * 60 * 6 },
  { label: '1 day', seconds: 60 * 60 * 24 },
  { label: '7 days', seconds: 60 * 60 * 24 * 7 },
  { label: '30 days', seconds: 60 * 60 * 24 * 30 },
];

const MAX_USES_OPTIONS: { label: string; value: number | null }[] = [
  { label: '1 use', value: 1 },
  { label: '5 uses', value: 5 },
  { label: '10 uses', value: 10 },
  { label: '25 uses', value: 25 },
  { label: '100 uses', value: 100 },
  { label: 'No limit', value: null },
];

type InviteStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

function inviteStatus(i: InviteRow, now: number): InviteStatus {
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt && new Date(i.expiresAt).getTime() < now) return 'expired';
  if (i.maxUses !== null && i.uses >= i.maxUses) return 'exhausted';
  return 'active';
}

function inviteUrl(code: string): string {
  return `${window.location.origin}/invites/${code}`;
}

function formatRelativeExpiry(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  const diff = t - now;
  if (diff < 0) {
    const absMins = Math.max(1, Math.round(-diff / 60_000));
    if (absMins < 60) return `${absMins} min ago`;
    const hrs = Math.round(absMins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }
  const mins = Math.max(1, Math.round(diff / 60_000));
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr`;
  return `in ${Math.round(hrs / 24)} d`;
}

export function ServerInvitesPanel({ serverId }: Props): JSX.Element {
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expirySeconds, setExpirySeconds] = useState<number>(60 * 60 * 24 * 7);
  const [maxUses, setMaxUses] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<InviteRow | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  // FE-13: confirm before destructive revoke. The trash-can button was
  // single-click → fire — an accidental tap permanently invalidated an
  // active invite with no undo. Same pattern as the peer-revoke modal.
  const [pendingRevoke, setPendingRevoke] = useState<InviteRow | null>(null);

  // Tick once a minute so the "expires in N min" labels stay roughly
  // fresh while the tab is open. Source of truth stays the server's
  // expiresAt; this is just for the cosmetic countdown.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await api<InviteRow[]>(`/servers/${serverId}/invites`);
      setRows(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load invites');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        scope: 'server',
        serverId,
        expiresInSeconds: expirySeconds,
      };
      if (maxUses !== null) body.maxUses = maxUses;
      const r = await api<InviteRow>('/invites', { method: 'POST', body });
      // The POST handler returns the base Invite shape (no createdBy join),
      // so synthesise it locally so the list row renders the creator name
      // immediately without a second round-trip.
      const enriched: InviteRow = { ...r, createdBy: r.createdBy ?? null };
      setLatest(enriched);
      setRows((s) => [enriched, ...s]);
      // Auto-copy so the buddy-share workflow is one click, not two.
      try {
        await navigator.clipboard.writeText(inviteUrl(enriched.code));
        toast.success('Invite minted and link copied');
      } catch {
        toast.success('Invite minted');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create invite');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    const stamp = new Date().toISOString();
    try {
      await api(`/invites/${id}`, { method: 'DELETE' });
      setRows((s) => s.map((r) => (r.id === id ? { ...r, revokedAt: stamp } : r)));
      if (latest?.id === id) {
        setLatest((l) => (l ? { ...l, revokedAt: stamp } : l));
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke invite');
    }
  }

  async function copyUrl(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl(code));
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded border border-subtle bg-surface p-4">
        <h2 className="font-serif text-lg">Pull up another chair</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Share an invite link so a friend can join this tavern. Each link
          expires; you can revoke any active link at any time.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <label className="block">
            <span className="text-xs text-fg-muted">Expires in</span>
            <select
              value={expirySeconds}
              onChange={(e) => setExpirySeconds(Number(e.target.value))}
              className="input mt-1"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-fg-muted">Max uses</span>
            <select
              value={maxUses === null ? '' : maxUses}
              onChange={(e) =>
                setMaxUses(e.target.value === '' ? null : Number(e.target.value))
              }
              className="input mt-1"
            >
              {MAX_USES_OPTIONS.map((o) => (
                <option key={o.label} value={o.value === null ? '' : o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void create()}
            disabled={busy}
          >
            <Plus size={14} className="mr-1.5 inline-block" /> Mint invite
          </button>
        </div>
        {latest ? (
          <div className="mt-3 rounded border border-ember bg-tint-ember p-3 text-sm">
            <p className="mb-2 font-medium">Invite ready — share this link:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
                {inviteUrl(latest.code)}
              </code>
              <button
                type="button"
                className="rounded p-1 hover:bg-raised"
                onClick={() => void copyUrl(latest.code)}
                aria-label="Copy invite link"
                title="Copy invite link"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded border border-subtle bg-surface p-4">
        <h2 className="font-serif text-lg">All invites</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {loading ? (
            <li className="text-fg-muted">Loading…</li>
          ) : rows.length === 0 ? (
            <li className="text-fg-muted">No invites yet.</li>
          ) : (
            rows.map((r) => {
              const status = inviteStatus(r, now);
              const isActive = status === 'active';
              return (
                <li
                  key={r.id}
                  className={
                    'flex flex-wrap items-center gap-2 rounded border border-subtle bg-canvas px-3 py-2 ' +
                    (isActive ? '' : 'opacity-60')
                  }
                >
                  <DoorOpen size={12} className="text-fg-muted" />
                  <code className="font-mono text-xs">{r.code}</code>
                  <StatusBadge status={status} />
                  <span className="font-mono text-xs text-fg-muted">
                    {r.uses}/{r.maxUses ?? '∞'} uses · expires{' '}
                    {formatRelativeExpiry(r.expiresAt, now)}
                  </span>
                  {r.createdBy ? (
                    <span className="ml-2 text-xs text-fg-muted">
                      by {r.createdBy.displayName}
                    </span>
                  ) : null}
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded p-1 text-fg-muted hover:bg-raised"
                      onClick={() => void copyUrl(r.code)}
                      aria-label="Copy invite link"
                      title="Copy invite link"
                    >
                      <Copy size={12} />
                    </button>
                    {isActive ? (
                      <button
                        type="button"
                        className="rounded p-1 text-fg-muted hover:bg-raised"
                        onClick={() => setPendingRevoke(r)}
                        aria-label="Revoke invite"
                        title="Revoke invite"
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </section>

      {pendingRevoke ? (
        <ConfirmDialog
          title="Revoke this invite?"
          description={`Anyone holding the link "${pendingRevoke.code}" will no longer be able to join with it. This cannot be undone.`}
          confirmLabel="Revoke"
          destructive
          onCancel={() => setPendingRevoke(null)}
          onConfirm={async () => {
            const id = pendingRevoke.id;
            setPendingRevoke(null);
            await revoke(id);
          }}
        />
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: InviteStatus }): JSX.Element {
  const label =
    status === 'active'
      ? 'Active'
      : status === 'revoked'
        ? 'Revoked'
        : status === 'expired'
          ? 'Expired'
          : 'Maxed out';
  const cls =
    status === 'active'
      ? 'border-ember bg-tint-ember text-fg'
      : 'border-subtle bg-sunken text-fg-muted';
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}
