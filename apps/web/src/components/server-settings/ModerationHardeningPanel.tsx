import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type {
  RaidProtectionConfig,
  Server,
  VerificationLevel,
} from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { useRealtime } from '../../lib/store.js';
import { useLockdown } from '../../lib/lockdown-store.js';
import { toast } from '../../lib/toast.js';

interface PresetRow {
  id: string;
  label: string;
  description: string;
  ruleCount: number;
  enabled: boolean;
}

const VERIFICATION_LABELS: Record<VerificationLevel, string> = {
  none: 'None — anyone can post',
  email_verified: 'Verified email',
  account_age: 'Minimum account age',
  must_pass_gate: 'Must pass the join gate',
};

/**
 * AutoMod presets + raid protection + verification levels (parity gap #4).
 * Rendered under the Safety policy tab.
 */
export function ModerationHardeningPanel({ serverId }: { serverId: string }): JSX.Element {
  const server = useRealtime((s) => s.serversById[serverId]) as Server | undefined;
  const liveLockdown = useLockdown((s) => s.byServer[serverId]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [raid, setRaid] = useState<RaidProtectionConfig | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [p, r] = await Promise.all([
        api<PresetRow[]>(`/servers/${serverId}/automod/presets`),
        api<RaidProtectionConfig>(`/servers/${serverId}/raid-protection`),
      ]);
      setPresets(p);
      setRaid(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load moderation settings');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function togglePreset(preset: PresetRow): Promise<void> {
    setBusy(true);
    try {
      await api(`/servers/${serverId}/automod/presets/${preset.id}`, {
        method: preset.enabled ? 'DELETE' : 'POST',
      });
      setPresets((all) =>
        all.map((p) => (p.id === preset.id ? { ...p, enabled: !p.enabled } : p)),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update preset');
    } finally {
      setBusy(false);
    }
  }

  async function saveRaid(patch: Partial<RaidProtectionConfig>): Promise<void> {
    if (!raid) return;
    const next = { ...raid, ...patch };
    setRaid(next);
    setBusy(true);
    try {
      const saved = await api<RaidProtectionConfig>(`/servers/${serverId}/raid-protection`, {
        method: 'PUT',
        body: {
          enabled: next.enabled,
          joinWindowSec: next.joinWindowSec,
          joinThreshold: next.joinThreshold,
          lockdownAction: next.lockdownAction,
        },
      });
      setRaid(saved);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function liftLockdown(): Promise<void> {
    setBusy(true);
    try {
      const saved = await api<RaidProtectionConfig>(`/servers/${serverId}/raid-protection/lift`, {
        method: 'POST',
      });
      setRaid(saved);
      toast.success('Lockdown lifted');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not lift');
    } finally {
      setBusy(false);
    }
  }

  async function saveVerification(patch: Partial<Server>): Promise<void> {
    setBusy(true);
    try {
      await api(`/servers/${serverId}`, { method: 'PATCH', body: patch });
      toast.success('Verification updated');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  const lockedDown = liveLockdown?.active ?? raid?.lockdownActive ?? false;

  return (
    <div className="space-y-6">
      {lockedDown ? (
        <div className="flex items-center gap-2 rounded border border-danger bg-tint-ember px-3 py-2 text-sm text-mead">
          <ShieldAlert size={16} />
          <span>Raid lockdown is active — new joins are being held.</span>
          <button
            type="button"
            className="ml-auto btn-ghost text-xs"
            disabled={busy}
            onClick={() => void liftLockdown()}
          >
            Lift now
          </button>
        </div>
      ) : null}

      <section className="space-y-2 rounded border border-subtle bg-surface p-5">
        <h2 className="font-serif text-lg">Auto-mod presets</h2>
        <p className="text-sm text-fg-muted">
          One-click rule bundles. After enabling, fine-tune the individual rules as needed.
        </p>
        <div className="space-y-2">
          {presets.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-start gap-3 rounded border border-subtle bg-canvas px-3 py-2"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={p.enabled}
                disabled={busy}
                onChange={() => void togglePreset(p)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{p.label}</span>
                <span className="block text-xs text-fg-muted">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {raid ? (
        <section className="space-y-3 rounded border border-subtle bg-surface p-5">
          <h2 className="font-serif text-lg">Raid protection</h2>
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-sm">Watch for join spikes</span>
            <input
              type="checkbox"
              checked={raid.enabled}
              disabled={busy}
              onChange={(e) => void saveRaid({ enabled: e.target.checked })}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">Joins</span>
              <input
                type="number"
                className="input w-full"
                min={2}
                max={1000}
                value={raid.joinThreshold}
                disabled={busy || !raid.enabled}
                onChange={(e) => setRaid({ ...raid, joinThreshold: Number(e.target.value) })}
                onBlur={() => void saveRaid({ joinThreshold: raid.joinThreshold })}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">Within (seconds)</span>
              <input
                type="number"
                className="input w-full"
                min={5}
                max={3600}
                value={raid.joinWindowSec}
                disabled={busy || !raid.enabled}
                onChange={(e) => setRaid({ ...raid, joinWindowSec: Number(e.target.value) })}
                onBlur={() => void saveRaid({ joinWindowSec: raid.joinWindowSec })}
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">When tripped</span>
            <select
              className="input w-full"
              value={raid.lockdownAction}
              disabled={busy || !raid.enabled}
              onChange={(e) =>
                void saveRaid({
                  lockdownAction: e.target.value as RaidProtectionConfig['lockdownAction'],
                })
              }
            >
              <option value="require_approval">Hold new members until lifted</option>
              <option value="pause_invites">Pause all joins</option>
              <option value="quarantine">Quarantine new members</option>
            </select>
          </label>
        </section>
      ) : null}

      <section className="space-y-2 rounded border border-subtle bg-surface p-5">
        <h2 className="font-serif text-lg">Verification</h2>
        <p className="text-sm text-fg-muted">
          Require new members to clear a bar before they can post.
        </p>
        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">Verification level</span>
          <select
            className="input w-full"
            value={server?.verificationLevel ?? 'none'}
            disabled={busy}
            onChange={(e) => void saveVerification({ verificationLevel: e.target.value as VerificationLevel })}
          >
            {(Object.keys(VERIFICATION_LABELS) as VerificationLevel[]).map((lvl) => (
              <option key={lvl} value={lvl}>
                {VERIFICATION_LABELS[lvl]}
              </option>
            ))}
          </select>
        </label>
        {server?.verificationLevel === 'account_age' ? (
          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Minimum account age (hours)</span>
            <input
              type="number"
              className="input w-40"
              min={0}
              max={8760}
              defaultValue={server?.verificationMinAccountAgeHours ?? 0}
              disabled={busy}
              onBlur={(e) =>
                void saveVerification({ verificationMinAccountAgeHours: Number(e.target.value) })
              }
            />
          </label>
        ) : null}
      </section>
    </div>
  );
}
