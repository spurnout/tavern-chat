import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  Role,
  ServerOnboarding,
  UpsertOnboardingPromptsRequest,
} from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { useRealtime } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';

/** Local editable shape for a prompt (mirrors the replace-all request body). */
interface DraftPrompt {
  title: string;
  multiSelect: boolean;
  options: Array<{ label: string; roleId: string | null }>;
}

export function OnboardingPanel({ serverId }: { serverId: string }): JSX.Element {
  const channels = useRealtime((s) => s.channelsByServer[serverId] ?? []);
  const server = useRealtime((s) => s.serversById[serverId]);
  const [data, setData] = useState<ServerOnboarding | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [prompts, setPrompts] = useState<DraftPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Text-only rooms make sense as system / recommended rooms.
  const textRooms = channels.filter((c) => c.type === 'text' || c.type === 'forum');

  async function refresh(): Promise<void> {
    try {
      const [onboarding, roleList] = await Promise.all([
        api<ServerOnboarding>(`/servers/${serverId}/onboarding`),
        api<Role[]>(`/servers/${serverId}/roles`),
      ]);
      setData(onboarding);
      setRoles(roleList.filter((r) => !r.isEveryone));
      setPrompts(
        onboarding.prompts.map((p) => ({
          title: p.title,
          multiSelect: p.multiSelect,
          options: p.options.map((o) => ({ label: o.label, roleId: o.roleId })),
        })),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load onboarding');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function saveConfig(patch: Partial<ServerOnboarding>): Promise<void> {
    if (!data) return;
    const next = { ...data, ...patch };
    setData(next);
    setBusy(true);
    setError(null);
    try {
      await api(`/servers/${serverId}/onboarding`, {
        method: 'PUT',
        body: {
          enabled: next.enabled,
          welcomeText: next.welcomeText,
          recommendedRooms: next.recommendedRooms,
          requireRules: next.requireRules,
        },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function setSystemRoom(channelId: string | null): Promise<void> {
    setBusy(true);
    try {
      await api(`/servers/${serverId}`, {
        method: 'PATCH',
        body: { systemChannelId: channelId },
      });
      toast.success('System room updated');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  async function savePrompts(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: UpsertOnboardingPromptsRequest = {
        prompts: prompts
          .filter((p) => p.title.trim() && p.options.some((o) => o.label.trim()))
          .map((p) => ({
            title: p.title.trim(),
            multiSelect: p.multiSelect,
            options: p.options
              .filter((o) => o.label.trim())
              .map((o) => ({ label: o.label.trim(), roleId: o.roleId, channelIds: [] })),
          })),
      };
      await api(`/servers/${serverId}/onboarding/prompts`, { method: 'PUT', body });
      toast.success('Prompts saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save prompts');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return error ? (
      <p className="text-sm text-danger">{error}</p>
    ) : (
      <p className="text-fg-muted">Loading…</p>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <section className="space-y-3 rounded border border-subtle bg-surface p-5">
        <h2 className="font-serif text-lg">Welcome screen</h2>
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm">Show a welcome screen to new members</span>
          <input
            type="checkbox"
            checked={data.enabled}
            disabled={busy}
            onChange={(e) => void saveConfig({ enabled: e.target.checked })}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm">Require accepting the rules before posting</span>
          <input
            type="checkbox"
            checked={data.requireRules}
            disabled={busy}
            onChange={(e) => void saveConfig({ requireRules: e.target.checked })}
          />
        </label>
        <label className="block">
          <span className="mb-1 inline-block text-sm text-fg-muted">Welcome message</span>
          <textarea
            className="input min-h-20 w-full"
            value={data.welcomeText}
            maxLength={4000}
            disabled={busy}
            placeholder="Pull up a chair — here’s how things work around here…"
            onChange={(e) => setData({ ...data, welcomeText: e.target.value })}
            onBlur={() => void saveConfig({ welcomeText: data.welcomeText })}
          />
        </label>
        {data.requireRules && !data.rulesMd ? (
          <p className="text-xs text-fg-muted">
            No rules are set yet. Add them under the join gate so members have something to accept.
          </p>
        ) : null}
      </section>

      <section className="space-y-2 rounded border border-subtle bg-surface p-5">
        <h2 className="font-serif text-lg">System room</h2>
        <p className="text-sm text-fg-muted">
          Where “joined the tavern” notices are posted. Leave unset to turn them off.
        </p>
        <select
          className="input w-full"
          value={server?.systemChannelId ?? ''}
          disabled={busy}
          onChange={(e) => void setSystemRoom(e.target.value || null)}
        >
          <option value="">No system room</option>
          {textRooms.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </section>

      <section className="space-y-3 rounded border border-subtle bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg">Role prompts</h2>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={busy}
            onClick={() =>
              setPrompts((p) => [...p, { title: '', multiSelect: true, options: [{ label: '', roleId: null }] }])
            }
          >
            <Plus size={12} className="mr-1 inline-block" />
            Add prompt
          </button>
        </div>
        <p className="text-sm text-fg-muted">
          Ask new members to pick from a set of self-assign roles.
        </p>
        {prompts.map((p, pi) => (
          <div key={pi} className="space-y-2 rounded border border-subtle bg-canvas p-3">
            <div className="flex items-center gap-2">
              <input
                className="input flex-1"
                value={p.title}
                placeholder="What do you play?"
                maxLength={120}
                onChange={(e) =>
                  setPrompts((all) => all.map((x, i) => (i === pi ? { ...x, title: e.target.value } : x)))
                }
              />
              <button
                type="button"
                className="rounded p-1 text-fg-muted hover:bg-raised"
                onClick={() => setPrompts((all) => all.filter((_, i) => i !== pi))}
                aria-label="Remove prompt"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {p.options.map((o, oi) => (
              <div key={oi} className="flex items-center gap-2 pl-3">
                <input
                  className="input flex-1"
                  value={o.label}
                  placeholder="Option label"
                  maxLength={80}
                  onChange={(e) =>
                    setPrompts((all) =>
                      all.map((x, i) =>
                        i === pi
                          ? {
                              ...x,
                              options: x.options.map((y, j) =>
                                j === oi ? { ...y, label: e.target.value } : y,
                              ),
                            }
                          : x,
                      ),
                    )
                  }
                />
                <select
                  className="input w-40"
                  value={o.roleId ?? ''}
                  onChange={(e) =>
                    setPrompts((all) =>
                      all.map((x, i) =>
                        i === pi
                          ? {
                              ...x,
                              options: x.options.map((y, j) =>
                                j === oi ? { ...y, roleId: e.target.value || null } : y,
                              ),
                            }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="">No role</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="rounded p-1 text-fg-muted hover:bg-raised"
                  onClick={() =>
                    setPrompts((all) =>
                      all.map((x, i) =>
                        i === pi ? { ...x, options: x.options.filter((_, j) => j !== oi) } : x,
                      ),
                    )
                  }
                  aria-label="Remove option"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-ghost ml-3 text-xs"
              onClick={() =>
                setPrompts((all) =>
                  all.map((x, i) =>
                    i === pi ? { ...x, options: [...x.options, { label: '', roleId: null }] } : x,
                  ),
                )
              }
            >
              <Plus size={11} className="mr-1 inline-block" />
              Add option
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-primary text-sm"
          disabled={busy}
          onClick={() => void savePrompts()}
        >
          Save prompts
        </button>
      </section>
    </div>
  );
}
