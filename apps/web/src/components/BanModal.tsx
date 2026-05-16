import { useState } from 'react';
import { Modal } from './Modal.js';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { cn } from '../lib/cn.js';

interface DurationPreset {
  label: string;
  hours: number | null; // null = forever
}

const DURATIONS: DurationPreset[] = [
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 7 * 24 },
  { label: '30 days', hours: 30 * 24 },
  { label: 'Forever', hours: null },
];

interface Props {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the user being banned. When omitted, the modal asks for an ID. */
  defaultUserId?: string;
  defaultDisplayName?: string;
  onApplied?: () => void;
}

/**
 * Ban-a-member modal. Mirrors the design-mockup ban flow: duration pills,
 * reason, "also delete last 24h of messages" toggle. Submits to the existing
 * `POST /api/servers/:id/bans` endpoint, which now accepts the sweep flags.
 */
export function BanModal({
  serverId,
  open,
  onOpenChange,
  defaultUserId,
  defaultDisplayName,
  onApplied,
}: Props): JSX.Element {
  const [userId, setUserId] = useState(defaultUserId ?? '');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<DurationPreset>(DURATIONS[3]!);
  const [sweep, setSweep] = useState(false);
  const [busy, setBusy] = useState(false);

  const targetLabel = defaultDisplayName ?? (userId.trim() || 'this member');
  const hasUser = (defaultUserId ?? userId.trim()).length > 0;

  async function submit(): Promise<void> {
    const id = (defaultUserId ?? userId).trim();
    if (!id) {
      toast.error('Pick someone to remove first.');
      return;
    }
    setBusy(true);
    try {
      const expiresAt =
        duration.hours === null
          ? undefined
          : new Date(Date.now() + duration.hours * 60 * 60 * 1000).toISOString();
      const res = await api<{ messagesDeleted: number }>(`/servers/${serverId}/bans`, {
        method: 'POST',
        body: {
          userId: id,
          reason: reason.trim() || undefined,
          expiresAt,
          alsoDeleteRecentMessages: sweep || undefined,
          deleteWithinHours: sweep ? 24 : undefined,
        },
      });
      if (sweep && res.messagesDeleted > 0) {
        toast.success(
          `${defaultDisplayName ?? 'Member'} removed. ${res.messagesDeleted} message${
            res.messagesDeleted === 1 ? '' : 's'
          } cleared.`,
        );
      } else {
        toast.success(`${defaultDisplayName ?? 'Member'} removed from the tavern.`);
      }
      setUserId('');
      setReason('');
      setSweep(false);
      onApplied?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove that member.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Remove from the tavern?"
      description={
        defaultDisplayName
          ? `This will end ${defaultDisplayName}'s chair and prevent return until lifted. They will not be told why.`
          : 'Removing a member ends their chair and prevents return until lifted. They will not be told why.'
      }
      footer={
        <>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => void submit()}
            disabled={busy || !hasUser}
          >
            {defaultDisplayName ? `Remove ${defaultDisplayName}` : 'Remove member'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {!defaultUserId ? (
          <label className="block text-sm">
            <span className="mb-1 block text-fg-muted">User ID</span>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="01JX…"
              className="input w-full font-mono"
              autoFocus
              disabled={busy}
            />
            <span className="mt-1 block text-xs text-fg-faint">
              Find a user's ID from their profile or the audit log.
            </span>
          </label>
        ) : (
          <div className="flex items-center gap-3 rounded border border-subtle bg-canvas p-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-raised font-serif text-sm">
              {(defaultDisplayName ?? '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-serif font-medium">{targetLabel}</div>
              <div className="truncate font-mono text-xs text-fg-faint">{defaultUserId}</div>
            </div>
          </div>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-fg-muted">Reason</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Tell us why. Visible to other hosts in the audit log."
            rows={3}
            className="input w-full resize-y"
            maxLength={2000}
            disabled={busy}
          />
        </label>

        <div>
          <div className="mb-1 text-sm text-fg-muted">How long</div>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDuration(d)}
                disabled={busy}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs',
                  duration.label === d.label
                    ? 'border-ember bg-tint-ember text-ember-hi'
                    : 'border-subtle text-fg-muted hover:bg-raised',
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={sweep}
            onChange={(e) => setSweep(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>
            <span className="text-fg">Also delete their last 24 hours of messages</span>
            <span className="mt-0.5 block text-xs text-fg-faint">
              Their posts in this tavern are removed. Replies and threads stay; the body is
              cleared.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
