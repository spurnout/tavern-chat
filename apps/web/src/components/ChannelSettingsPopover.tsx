import { useEffect, useRef, useState } from 'react';
import { Settings, X } from 'lucide-react';
import type { Channel } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useRealtime } from '../lib/store.js';

interface Props {
  channel: Channel;
  canManage: boolean;
}

type PostingScope = 'open' | 'mods_only' | 'admin_only';

const SLOWMODE_PRESETS = [0, 5, 10, 30, 60, 300, 900, 3600, 21600];

/**
 * Per-channel settings (Wave 2 #8 slowmode + #9 posting scope). The plan
 * called for a full settings modal; for now this is a compact popover
 * triggered from the channel header. Owners and members with MANAGE_CHANNELS
 * see the controls; everyone else just sees the read-only summary.
 */
export function ChannelSettingsPopover({ channel, canManage }: Props): JSX.Element {
  const upsertChannel = useRealtime((s) => s.upsertChannel);
  const [open, setOpen] = useState(false);
  const [slowmode, setSlowmode] = useState((channel as unknown as { slowmodeSeconds?: number }).slowmodeSeconds ?? 0);
  const [scope, setScope] = useState<PostingScope>(
    (channel as unknown as { postingScope?: PostingScope }).postingScope ?? 'open',
  );
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<Channel>(`/channels/${channel.id}`, {
        method: 'PATCH',
        body: { slowmodeSeconds: slowmode, postingScope: scope },
      });
      upsertChannel(r);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1 hover:bg-raised"
        aria-label="Channel settings"
        title="Channel settings"
      >
        <Settings size={14} />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full z-30 mt-2 w-80 rounded border border-subtle bg-surface shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-subtle px-3 py-2">
            <h2 className="font-serif text-sm">Room settings</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 hover:bg-raised"
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </header>
          <div className="space-y-3 px-3 py-2 text-sm">
            <label className="block">
              <span className="text-fg-muted">Slow mode</span>
              <select
                value={slowmode}
                onChange={(e) => setSlowmode(Number(e.target.value))}
                disabled={!canManage}
                className="input mt-1 w-full"
              >
                {SLOWMODE_PRESETS.map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? 'Off' : formatSeconds(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-fg-muted">Who can post</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as PostingScope)}
                disabled={!canManage}
                className="input mt-1 w-full"
              >
                <option value="open">Everyone</option>
                <option value="mods_only">Moderators only</option>
                <option value="admin_only">Admins only</option>
              </select>
            </label>
            {canManage ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn-primary text-xs"
                  onClick={() => void save()}
                  disabled={busy}
                >
                  Save
                </button>
              </div>
            ) : (
              <p className="text-xs italic text-fg-muted">
                You don’t have MANAGE_CHANNELS in this tavern.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
