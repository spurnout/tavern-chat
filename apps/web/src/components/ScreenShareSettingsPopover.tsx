import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import type { ScreenShareOptions } from './VoiceRoom.js';

interface Props {
  disabled: boolean;
  value: ScreenShareOptions;
  onChange: (next: ScreenShareOptions) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Settings hung off the screen-share toggle: choose whether to capture audio
 * along with the picture, and whether to bias the encoder for sharp text.
 *
 * Settings only apply to the *next* share — flipping options mid-stream would
 * republish the track and is intentionally not supported.
 */
export function ScreenShareSettingsPopover({
  disabled,
  value,
  onChange,
  open,
  onOpenChange,
}: Props): JSX.Element {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="rounded-md px-1 py-2 text-fg-muted transition-base hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          title="Screen sharing options"
          aria-label="Screen sharing options"
        >
          <ChevronDown size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-72 rounded-md border border-subtle bg-surface p-3 shadow-lg"
        >
          <div className="text-xs font-medium uppercase tracking-wider text-fg-muted">
            Before you share
          </div>
          <ToggleRow
            label="Share audio (when possible)"
            description="Tab captures only that tab's audio. Sharing a window or your whole screen on Windows or Linux can capture other apps' sound too — check before you share."
            checked={value.audio}
            onChange={(next) => onChange({ ...value, audio: next })}
          />
          <ToggleRow
            label="Sharp text mode"
            description="Better for code or documents; slower for motion."
            checked={value.contentHint === 'text'}
            onChange={(next) =>
              onChange({ ...value, contentHint: next ? 'text' : 'motion' })
            }
          />
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border border-default bg-sunken accent-ember"
      />
      <span className="flex flex-col">
        <span className="text-sm text-fg">{label}</span>
        <span className="text-xs text-fg-muted">{description}</span>
      </span>
    </label>
  );
}
