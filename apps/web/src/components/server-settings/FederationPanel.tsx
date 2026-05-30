import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Server } from '@tavern/shared';
import { Permission } from '@tavern/shared';
import { api, ApiError, leaveMirrorServer } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';
import { useCanIn, useRealtime } from '../../lib/store.js';

// P3-10 — per-Tavern federation toggle. Gated on two flags:
//   1. The viewer holds MANAGE_SERVER on the den (read from the realtime
//      store, which is hydrated by `loadMyServerPermissions`).
//   2. The instance has FEDERATION_ENABLED=true (read from `/api/instance`;
//      same surface the login page consumes for SSO label discovery).
// Both must be true for the toggle to be operable. Failing case 2 we still
// render the tab so the admin understands why the affordance is missing
// — silent omission would be confusing.

export function FederationPanel({ serverId }: { serverId: string }): JSX.Element {
  const canManage = useCanIn(serverId, Permission.MANAGE_SERVER);
  const loadMyServerPermissions = useRealtime((s) => s.loadMyServerPermissions);
  const navigate = useNavigate();
  const [server, setServer] = useState<Server | null>(null);
  const [instanceFederationOn, setInstanceFederationOn] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // P4-16 — mirror tear-down is a separate in-flight flag so the leave button
  // can disable independently from the federation toggle. The mirror branch
  // never shows the toggle, but keeping the flags separate makes the
  // surfaces unambiguous if a future branch needs both.
  const [leaving, setLeaving] = useState(false);
  // Tracks whether the async permission load has settled. Without this, a
  // real admin can see the "no permission" branch in the small window before
  // `loadMyServerPermissions` resolves and hydrates `useCanIn` — `canManage`
  // defaults to false while the cache is cold, and the server/instance load
  // below may resolve first. We render the loading state until BOTH this and
  // the server/instance data have landed.
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMyServerPermissions(serverId)
      .catch(() => {
        // Swallow — the existing "no permission" / loading branches handle
        // the user-visible outcome. A failure to load permissions just leaves
        // `canManage` at its default `false`, which falls through to the
        // explanatory "no permission" message.
      })
      .finally(() => {
        if (!cancelled) setPermissionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, loadMyServerPermissions]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([
      api<Server>(`/servers/${serverId}`),
      api<{ features: { federationEnabled?: boolean } }>('/instance', { retryOn401: false }),
    ])
      .then(([srv, inst]) => {
        if (cancelled) return;
        setServer(srv);
        setInstanceFederationOn(Boolean(inst.features.federationEnabled));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'Could not load federation settings');
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function setEnabled(next: boolean): Promise<void> {
    if (!server || busy) return;
    setBusy(true);
    try {
      const updated = await api<Server>(`/servers/${serverId}`, {
        method: 'PATCH',
        body: { federationEnabled: next },
      });
      setServer(updated);
      toast.success(next ? 'Federation turned on for this den.' : 'Federation turned off for this den.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update federation.');
    } finally {
      setBusy(false);
    }
  }

  // P4-16 — leave a mirror den. The API synchronously round-trips a signed
  // member.leave to the home; on success it deletes the local ServerMember
  // and (if the leaver was the last local member) tears down the mirror.
  // Either way we navigate back to /app so the user lands somewhere safe;
  // the realtime SERVER_REMOVE handler splices the row out of the store on
  // the next tick if the tear-down fired.
  async function handleLeaveMirror(): Promise<void> {
    if (!server || leaving) return;
    setLeaving(true);
    try {
      await leaveMirrorServer(serverId);
      toast.success(`Left ${server.name}.`);
      await navigate({ to: '/app' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not leave this den.');
    } finally {
      setLeaving(false);
    }
  }

  if (loadError) {
    return <p className="text-sm text-danger">{loadError}</p>;
  }
  if (!server || instanceFederationOn === null || !permissionsLoaded) {
    return <p className="text-fg-muted">Loading…</p>;
  }

  // P4-16 — mirror den branch. Comes before the canManage gate because any
  // local member of a mirror is allowed to leave, regardless of role.
  // Mirrors don't have a local federation toggle to manage — the canonical
  // state lives on the home instance — so the toggle UI is suppressed
  // entirely and replaced with the leave-this-den affordance.
  if (server.originInstanceId !== null) {
    const host = server.originInstanceHost ?? 'a peered instance';
    return (
      <div className="space-y-6">
        <section className="space-y-2">
          <h2 className="font-serif text-lg font-medium">This is a federated den</h2>
          <p className="text-sm text-fg-muted">
            Hosted by {host}. You can leave at any time — your local messages here will stop
            syncing back.
          </p>
        </section>
        <section className="space-y-3 rounded border border-subtle bg-surface p-4">
          <button
            type="button"
            className="btn-danger"
            disabled={leaving}
            onClick={() => void handleLeaveMirror()}
          >
            {leaving ? 'Leaving…' : 'Leave this den'}
          </button>
        </section>
      </div>
    );
  }

  if (!canManage) {
    return (
      <section className="space-y-2">
        <h2 className="font-serif text-lg font-medium">Federation</h2>
        <p className="text-sm text-fg-muted">
          You don&apos;t have permission to change federation settings for this den.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-serif text-lg font-medium">Federation</h2>
        <p className="text-sm text-fg-muted">
          Federation lets members from peered instances pull up a chair in your rooms. The toggle
          here is the den-wide switch; each room can still opt out (or force in) via its own
          override.
        </p>
      </section>

      {instanceFederationOn ? (
        <section className="space-y-3 rounded border border-subtle bg-surface p-4">
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span>
              <span className="block font-serif font-medium">Federate this den</span>
              <span className="mt-1 block text-sm text-fg-muted">
                When on, rooms in this den can exchange messages with members from peered
                instances. Per-room overrides are set inside each room.
              </span>
            </span>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0"
              checked={server.federationEnabled}
              disabled={busy}
              onChange={(e) => void setEnabled(e.target.checked)}
            />
          </label>
        </section>
      ) : (
        <section className="space-y-2 rounded border border-subtle bg-sunken p-4">
          <p className="text-sm text-fg">
            This instance is not federation-enabled. Ask the operator to set{' '}
            <code className="rounded bg-canvas px-1 py-0.5 text-xs">FEDERATION_ENABLED=true</code>{' '}
            in the <code className="rounded bg-canvas px-1 py-0.5 text-xs">.env</code> before you
            can turn on federation for this den.
          </p>
        </section>
      )}
    </div>
  );
}
