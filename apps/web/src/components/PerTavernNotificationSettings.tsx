import { useEffect } from 'react';
import { useNotificationSettings } from '../lib/notification-settings.js';

interface Props {
  serverId: string;
}

/**
 * Per-tavern overrides for the calling user. Lives in the den settings
 * page as the "Notifications" tab and lets each member silence a specific
 * tavern without touching their global preferences.
 */
export function PerTavernNotificationSettings({ serverId }: Props): JSX.Element {
  const prefs = useNotificationSettings((s) => s.perTavern[serverId]);
  const loadPerTavern = useNotificationSettings((s) => s.loadPerTavern);
  const updatePerTavern = useNotificationSettings((s) => s.updatePerTavern);

  useEffect(() => {
    if (!prefs) {
      void loadPerTavern(serverId);
    }
  }, [serverId, prefs, loadPerTavern]);

  const current = prefs ?? {
    serverId,
    muteAll: false,
    muteMessages: false,
    muteMentions: false,
  };

  return (
    <div className="max-w-xl space-y-4">
      <div>
        <h2 className="font-serif text-base font-medium">Notifications</h2>
        <p className="text-sm text-fg-muted">
          Silence what reaches you from this tavern. Your global settings still apply on top.
        </p>
      </div>
      <div className="space-y-2 rounded-md border border-subtle bg-surface p-4">
        <ToggleRow
          label="Mute this tavern entirely"
          description="No chimes from this tavern at all — neither messages nor mentions."
          checked={current.muteAll}
          onChange={(v) => void updatePerTavern(serverId, { muteAll: v })}
        />
        <ToggleRow
          label="Mute regular messages"
          description="Mentions still chime (unless you mute those below)."
          checked={current.muteMessages}
          disabled={current.muteAll}
          onChange={(v) => void updatePerTavern(serverId, { muteMessages: v })}
        />
        <ToggleRow
          label="Mute @mentions"
          description="Silence even direct mentions from this tavern."
          checked={current.muteMentions}
          disabled={current.muteAll}
          onChange={(v) => void updatePerTavern(serverId, { muteMentions: v })}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label
      className={`flex items-start justify-between gap-3 rounded px-1 py-1 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-raised'
      }`}
    >
      <span>
        <span className="block text-sm text-fg">{label}</span>
        <span className="block text-xs text-fg-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-ember"
        aria-label={label}
      />
    </label>
  );
}
