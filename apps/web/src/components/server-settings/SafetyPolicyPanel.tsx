import { useEffect, useState } from 'react';
import type { SafetyPolicy, UpdateSafetyPolicyRequest } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';

export function SafetyPolicyPanel({ serverId }: { serverId: string }): JSX.Element {
  const [policy, setPolicy] = useState<SafetyPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const p = await api<SafetyPolicy>(`/servers/${serverId}/safety-policy`);
      setPolicy(p);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load policy');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function patch(patch: UpdateSafetyPolicyRequest): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<SafetyPolicy>(`/servers/${serverId}/safety-policy`, {
        method: 'PATCH',
        body: patch,
      });
      setPolicy(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  if (!policy) {
    return error ? (
      <p className="text-sm text-danger">{error}</p>
    ) : (
      <p className="text-fg-muted">Loading…</p>
    );
  }

  const Toggle = ({
    label,
    field,
  }: {
    label: string;
    field: keyof Pick<
      SafetyPolicy,
      | 'sfwOnly'
      | 'allowNsfwChannels'
      | 'spoilerTagsEnabled'
      | 'blockExecutableUploads'
      | 'blockArchiveUploads'
      | 'stripImageMetadata'
    >;
  }): JSX.Element => (
    <label className="flex cursor-pointer items-center justify-between rounded border border-subtle px-3 py-2 hover:bg-raised">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={policy[field]}
        disabled={busy}
        onChange={(e) => void patch({ [field]: e.target.checked } as UpdateSafetyPolicyRequest)}
      />
    </label>
  );

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle label="SFW only" field="sfwOnly" />
        <Toggle label="Allow NSFW rooms" field="allowNsfwChannels" />
        <Toggle label="Spoiler tags enabled" field="spoilerTagsEnabled" />
        <Toggle label="Block executable uploads" field="blockExecutableUploads" />
        <Toggle label="Block archive uploads" field="blockArchiveUploads" />
        <Toggle label="Strip image EXIF metadata" field="stripImageMetadata" />
      </div>
      <label className="block">
        <span className="mb-1 inline-block text-fg-muted text-sm">Profanity filter</span>
        <select
          className="input w-40"
          value={policy.profanityFilter}
          disabled={busy}
          onChange={(e) =>
            void patch({
              profanityFilter: e.target.value as 'off' | 'soft' | 'strict',
            })
          }
        >
          <option value="off">Off</option>
          <option value="soft">Soft</option>
          <option value="strict">Strict</option>
        </select>
      </label>
    </div>
  );
}
