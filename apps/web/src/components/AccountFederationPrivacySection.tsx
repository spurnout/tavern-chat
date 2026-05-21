import { useState } from 'react';
import type { AccountSettings, Capability, Me } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth.js';
import { toast } from '../lib/toast.js';

/**
 * PF-5 — Federation privacy toggles.
 *
 * Two per-user opt-outs governing how this account interacts with federated
 * peers. Each row is rendered only when the instance advertises the matching
 * capability — there's no point offering "stop sharing my presence" on an
 * instance where presence federation is disabled at the operator level.
 *
 * State source: the Me bootstrap already carries both booleans plus
 * `instanceCapabilities`, so there's no extra fetch on mount. Mutations PATCH
 * `/api/me/account` and merge the response into the in-memory Me on success;
 * failures rollback the optimistic toggle and surface a toast (the same
 * pattern AccountSecuritySection / AccountPushSection use).
 *
 * The section silently renders nothing when the instance advertises neither
 * `dms` nor `presence` — either because federation is off entirely or because
 * the operator has disabled both flags. Showing an empty card would be noisy.
 */
export function AccountFederationPrivacySection(): JSX.Element | null {
  const me = useAuth((s) => s.me);
  const [busy, setBusy] = useState<null | keyof AccountSettings>(null);

  if (!me) return null;

  const caps: Capability[] = me.instanceCapabilities;
  const showDms = caps.includes('dms');
  const showPresence = caps.includes('presence');
  if (!showDms && !showPresence) return null;

  async function update<K extends keyof AccountSettings>(
    key: K,
    next: boolean,
  ): Promise<void> {
    // Optimistic: flip the in-memory Me right away so the toggle moves under
    // the user's finger. Roll back on error.
    const prev = me?.[key] ?? true;
    useAuth.setState((s) => (s.me ? { me: { ...s.me, [key]: next } } : s));
    setBusy(key);
    try {
      const settings = await api<AccountSettings>('/me/account', {
        method: 'PATCH',
        body: { [key]: next },
      });
      useAuth.setState((s) =>
        s.me ? { me: { ...s.me, ...settings } satisfies Me } : s,
      );
    } catch (err) {
      // Rollback optimistic change.
      useAuth.setState((s) => (s.me ? { me: { ...s.me, [key]: prev } } : s));
      toast.error(err instanceof ApiError ? err.message : 'Could not save preference.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Federation privacy</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Control what other instances see about you. These only apply to taverns shared with
        federated peers.
      </p>
      <div className="mt-3 space-y-3 text-sm">
        {showPresence ? (
          <ToggleRow
            label="Share my presence with federated peers"
            description={
              me.acceptsFederatedPresence
                ? 'Other instances see when you come online, go idle, or sign off.'
                : "Other instances won't see when you're online."
            }
            checked={me.acceptsFederatedPresence}
            busy={busy === 'acceptsFederatedPresence'}
            onChange={(next) => void update('acceptsFederatedPresence', next)}
          />
        ) : null}
        {showDms ? (
          <ToggleRow
            label="Accept new direct messages from federated peers"
            description={
              me.acceptsFederatedDms
                ? 'Members on other instances can start a new direct message with you.'
                : "Remote members won't be able to send you new direct messages. Existing conversations stay open."
            }
            checked={me.acceptsFederatedDms}
            busy={busy === 'acceptsFederatedDms'}
            onChange={(next) => void update('acceptsFederatedDms', next)}
          />
        ) : null}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        <span className="block text-xs text-fg-muted">{description}</span>
      </span>
    </label>
  );
}
