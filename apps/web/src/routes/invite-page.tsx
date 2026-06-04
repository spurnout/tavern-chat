import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useAuth } from '../lib/auth.js';
import { useRealtime } from '../lib/store.js';
import { FederatedInvitePreviewModal } from '../components/FederatedInvitePreviewModal.js';
import { normalizeInviteCode, savePendingInvite } from '../lib/pending-invite.js';

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
 * the user is logged in (in which case we send them to registration with the
 * invite preserved for after account creation) or once authenticated.
 */
export function InvitePage(): JSX.Element {
  const params = useParams({ strict: false }) as { code?: string };
  const code = params.code ? normalizeInviteCode(params.code) : undefined;
  // useSearch's strict-mode-off form returns the query object; TanStack Router
  // doesn't type-narrow the param shape without a route schema, so we cast.
  const search = useSearch({ strict: false }) as { host?: string };
  const me = useAuth((s) => s.me);
  const authStatus = useAuth((s) => s.status);
  const bootstrapAuth = useAuth((s) => s.bootstrap);
  const upsertServer = useRealtime((s) => s.upsertServer);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const host = typeof search.host === 'string' && search.host.length > 0 ? search.host : null;

  useEffect(() => {
    if (authStatus === 'idle') void bootstrapAuth();
  }, [authStatus, bootstrapAuth]);

  useEffect(() => {
    if (!code) return;
    if (authStatus === 'unauthenticated' || authStatus === 'error') {
      savePendingInvite(code, host);
      void navigate({ to: '/register', replace: true });
    }
  }, [authStatus, code, host, navigate]);

  // Local-invite path: redeem immediately on mount. We don't wait for user
  // confirmation here — the original /invites/:code shape predates federation
  // and assumed a single-click join. Preserving that UX for non-federated
  // links keeps the upgrade non-breaking. (Future polish: add a confirmation
  // step for local invites too if the host server has a join-gate.)
  useEffect(() => {
    if (!code || host) return; // federated path handled by modal
    if (!me || authStatus !== 'authenticated') {
      return;
    }
    let cancelled = false;
    setJoining(true);
    api<{ serverId: string | null }>(`/invites/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: {},
    })
      .then(async ({ serverId }) => {
        if (cancelled) return;
        // Instance-scoped invite redeemed by an already-authenticated user:
        // the backend returns `serverId: null` because there is no server to
        // join. Send them home with a soft acknowledgement instead of
        // trying to fetch `/servers/null`.
        if (serverId === null) {
          toast.success("You're already at this Tavern.");
          await navigate({ to: '/app' });
          return;
        }
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
  }, [authStatus, code, host, me, navigate, upsertServer]);

  // Federated path: open the modal on mount. When the user closes/cancels
  // we send them home (the URL no longer represents a usable state once
  // they've dismissed the prompt). Accept-and-navigate is handled inside
  // the modal.
  useEffect(() => {
    if (!code || !host) return;
    if (!me || authStatus !== 'authenticated') {
      return;
    }
    setPreviewOpen(true);
  }, [authStatus, code, host, me]);

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
      {error ? (
        <p className="text-danger">{error}</p>
      ) : joining || authStatus === 'idle' || authStatus === 'loading' ? (
        'Joining the tavern…'
      ) : null}
    </div>
  );
}
