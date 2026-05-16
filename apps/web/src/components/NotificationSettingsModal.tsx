import { Modal } from './Modal.js';
import { useNotificationSettings } from '../lib/notification-settings.js';
import { playSound, type SoundName } from '../lib/sound.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Global notification preferences — master sound toggle, volume, when-to-play
 * gates, and a few test-fire buttons so the user can audit each sound.
 *
 * Per-tavern overrides (mute this den, mute mentions) live in the tavern's
 * settings page, not here.
 */
export function NotificationSettingsModal({ open, onOpenChange }: Props): JSX.Element {
  const global = useNotificationSettings((s) => s.global);
  const updateGlobal = useNotificationSettings((s) => s.updateGlobal);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Notification sounds"
      description="How and when Tavern's chimes play."
      widthClass="w-[min(95vw,560px)]"
    >
      <div className="space-y-6">
        <section>
          <ToggleRow
            label="Sounds on"
            description="Master switch. When off, nothing chimes."
            checked={global.soundEnabled}
            onChange={(v) => void updateGlobal({ soundEnabled: v })}
          />
          <div className="mt-4">
            <label className="block text-sm font-medium text-fg">Volume</label>
            <p className="text-xs text-fg-muted">How loud the chimes ring.</p>
            <input
              type="range"
              min={0}
              max={100}
              value={global.volume}
              disabled={!global.soundEnabled}
              onChange={(e) => void updateGlobal({ volume: Number(e.target.value) })}
              className="mt-2 w-full"
              aria-label="Volume"
            />
            <div className="text-right text-xs text-fg-muted">{global.volume}</div>
          </div>
        </section>

        <section>
          <h3 className="font-serif text-sm font-medium text-fg">When to play chat sounds</h3>
          <div className="mt-2 space-y-2">
            <ToggleRow
              label="Only when I'm not looking at the room"
              description="Skip the chime if you're already viewing the channel a message lands in."
              checked={global.playOnlyWhenUnfocused}
              onChange={(v) => void updateGlobal({ playOnlyWhenUnfocused: v })}
            />
            <ToggleRow
              label="Even while I'm in a voice call"
              description="On by default. Turn off to keep voice rooms quiet of chat chimes."
              checked={global.chatSoundsWhileInVoice}
              onChange={(v) => void updateGlobal({ chatSoundsWhileInVoice: v })}
            />
            <ToggleRow
              label="Mentions always ring"
              description="An @mention plays its sound even if the tavern is otherwise muted."
              checked={global.mentionsOverrideMute}
              onChange={(v) => void updateGlobal({ mentionsOverrideMute: v })}
            />
          </div>
        </section>

        <section>
          <h3 className="font-serif text-sm font-medium text-fg">Try a sound</h3>
          <p className="text-xs text-fg-muted">Click to hear what each chime sounds like.</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <TestSoundButton name="message" label="Message" />
            <TestSoundButton name="mention" label="Mention" />
            <TestSoundButton name="roll" label="Dice roll" />
            <TestSoundButton name="vc-self-join" label="Voice join" />
            <TestSoundButton name="vc-self-leave" label="Voice leave" />
            <TestSoundButton name="screenshare-start" label="Screen share on" />
            <TestSoundButton name="screenshare-stop" label="Screen share off" />
            <TestSoundButton name="voice-join" label="Someone joins" />
            <TestSoundButton name="voice-leave" label="Someone leaves" />
          </div>
        </section>
      </div>
    </Modal>
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
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md px-1 py-1 hover:bg-raised">
      <span>
        <span className="block text-sm text-fg">{label}</span>
        <span className="block text-xs text-fg-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-ember"
        aria-label={label}
      />
    </label>
  );
}

function TestSoundButton({ name, label }: { name: SoundName; label: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => playSound(name)}
      className="rounded border border-subtle bg-surface px-2 py-1.5 text-xs text-fg hover:bg-raised"
    >
      {label}
    </button>
  );
}
