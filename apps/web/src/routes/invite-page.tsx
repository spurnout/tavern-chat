import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useAuth } from '../lib/auth.js';
import { useRealtime } from '../lib/store.js';
import { FederatedInvitePreviewModal } from '../components/FederatedInvitePreviewModal.js';

/**
 * Federation Phase 4 / P4-16 — invite URL handler.
 *
 * URL shape:
 *   - Local invite:     `/invites/{code}`           → POST /api/invites/{code}/join, navigate.
 *   - Federated invite: `/invites/{code}?host={h}`  → open FederatedInvitePreviewModal,
 *                                                     which previews via the API passthrough
 *                                                     and accepts on confirmation.
 *
 * The `?host=` query param is the federated marker. Its presence flips the
 * handler from "redeem here" to "show preview + ask user before joining the
 * peer's den."
 *
 * Auth: this route lives outside the AppShell so it can render either before
 * the user is logged in (in which case we redirect to /login, preserving the
 * invite for after sign-in) or once authenticated. The simplest path right
 * now is to require auth — federated invites only make sense for logged-in
 * users on a particular instance.
 */
export function InvitePage(): JSX.Element {
  const { code } = useParams({ strict: false }) as { code?: string };
  // useSearch's strict-mode-off form returns the query object; TanStack Router
  // doesn't type-narrow the param shape without a route schema, so we cast.
  const search = useSearch({ strict: false }) as { host?: string };
  const me = useAuth((s) => s.me);
  const upsertServer = useRealtime((s) => s.upsertServer);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const host = typeof search.host === 'string' && search.host.length > 0 ? search.host : null;

  // Local-invite path: redeem immediately on mount. We don't wait for user
  // confirmation here — the original /invites/:code shape predates federation
  // and assumed a single-click join. Preserving that UX for non-federated
  // links keeps the upgrade non-breaking. (Future polish: add a confirmation
  // step for local invites too if the host server has a join-gate.)
  useEffect(() => {
    if (!code || host) return; // federated path handled by modal
    if (!me) {
      void navigate({ to: '/login' });
      return;
    }
    let cancelled = false;
    setJoining(true);
    api<{ serverId: string }>(`/invites/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: {},
    })
      .then(async ({ serverId }) => {
        if (cancelled) return;
        // Pull the fresh server row so the sidebar can render it without a
        // /servers refetch (the gateway also fires a MEMBER_ADD broadcast but
        // SERVER_ADD is not synthesised for local joins).
        try {
          const srv = await api<import('@tavern/shared').Server>(`/servers/${serverId}`);
          upsertServer(srv);
        } catch {
          /* non-fatal — sidebar will catch up on next refresh */
        }
        toast.success('Pulled up a chair.');
        await navigate({ to: '/app/servers/$serverId', params: { serverId } });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not redeem this invite.');
      })
      .finally(() => {
        if (!cancelled) setJoining(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, host, me, navigate, upsertServer]);

  // Federated path: open the modal on mount. When the user closes/cancels
  // we send them home (the URL no longer represents a usable state once
  // they've dismissed the prompt). Accept-and-navigate is handled inside
  // the modal.
  useEffect(() => {
    if (!code || !host) return;
    if (!me) {
      void navigate({ to: '/login' });
      return;
    }
    setPreviewOpen(true);
  }, [code, host, me, navigate]);

  if (!code) {
    return (
      <div className="grid h-full place-items-center p-12 text-sm text-fg-muted">
        No invite code in the URL.
      </div>
    );
  }

  if (host) {
    return (
      <>
        <div className="grid h-full place-items-center p-12 text-sm text-fg-muted">
          Loading invite…
        </div>
        <FederatedInvitePreviewModal
          host={host}
          code={code}
          open={previewOpen}
          onOpenChange={(open) => {
            setPreviewOpen(open);
            if (!open) {
              void navigate({ to: '/app' });
            }
          }}
        />
      </>
    );
  }

  return (
    <div className="grid h-full place-items-center p-12 text-sm text-fg-muted">
      {error ? <p className="text-danger">{error}</p> : joining ? 'Joining the den…' : null}
    </div>
  );
}
