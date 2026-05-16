import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import type { Presence } from '@tavern/shared';
import { useAuth } from '../lib/auth.js';
import { useRealtime } from '../lib/store.js';
import { setManualDnd } from '../lib/presence.js';
import { PresenceDot } from './PresenceDot.js';
import { cn } from '../lib/cn.js';

/**
 * The "current user" pill: clickable swatch showing your presence, opens a
 * popover with status options (active / do not disturb). Idle is derived
 * automatically by the idle timer and not user-selectable here.
 */
export function UserStatusPopover(): JSX.Element {
  const me = useAuth((s) => s.me);
  const presenceByUserId = useRealtime((s) => s.presenceByUserId);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!me) return <></>;
  const current: Presence = presenceByUserId[me.id] ?? me.presence ?? 'offline';

  async function pick(dnd: boolean): Promise<void> {
    setPending(true);
    try {
      await setManualDnd(dnd);
      setOpen(false);
    } catch {
      // Keep popover open so the user knows something didn't take.
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Set your status"
          title="Set your status"
          className="relative rounded p-1 hover:bg-raised"
        >
          <PresenceDot presence={current} size={3} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-56 rounded-md border border-subtle bg-surface p-2 shadow-lg"
        >
          <div className="px-2 pb-1 pt-1 text-xs uppercase tracking-wider text-fg-muted">
            Status
          </div>
          <StatusOption
            label="Active"
            description="Hear sounds, show as available"
            presence="active"
            selected={current === 'active'}
            disabled={pending}
            onSelect={() => void pick(false)}
          />
          <StatusOption
            label="Do not disturb"
            description="Silence chat sounds"
            presence="dnd"
            selected={current === 'dnd'}
            disabled={pending}
            onSelect={() => void pick(true)}
          />
          {current === 'idle' ? (
            <div className="mt-1 border-t border-subtle px-2 pt-2 text-xs text-fg-muted">
              You&apos;ll go back to active automatically when you start using the app again.
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function StatusOption({
  label,
  description,
  presence,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  presence: Presence;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
        selected ? 'bg-raised' : 'hover:bg-raised',
        disabled ? 'cursor-wait opacity-60' : '',
      )}
    >
      <PresenceDot presence={presence} size={2.5} />
      <span className="min-w-0 flex-1">
        <span className="block font-serif">{label}</span>
        <span className="block text-xs text-fg-muted">{description}</span>
      </span>
    </button>
  );
}
