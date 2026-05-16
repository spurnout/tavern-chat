import { usePreferences, type FontName, type FontSize, type ThemeName } from '../lib/preferences-store.js';

/**
 * Wave 3 #30 / #33 — Appearance & motion preferences. Theme, font family,
 * font size, and reduce-motion toggle. Preferences persist client-side; a
 * follow-up syncs them to the server-side User row.
 */
export function AccountAppearanceSection(): JSX.Element {
  const { theme, font, size, reduceMotion, setTheme, setFont, setSize, setReduceMotion } =
    usePreferences();

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Appearance</h2>
      <p className="mt-1 text-sm text-fg-muted">
        How Tavern looks and moves. Saved on this device.
      </p>
      <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
        <label className="block">
          <span className="text-xs text-fg-muted">Theme</span>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeName)}
            className="input mt-1 w-full"
          >
            <option value="tavern">Tavern (warm)</option>
            <option value="dark">Dark</option>
            <option value="sepia">Sepia</option>
            <option value="highContrast">High contrast</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-fg-muted">Font</span>
          <select
            value={font}
            onChange={(e) => setFont(e.target.value as FontName)}
            className="input mt-1 w-full"
          >
            <option value="serif">Serif (default)</option>
            <option value="sans">Sans-serif</option>
            <option value="dyslexia">OpenDyslexic</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-fg-muted">Text size</span>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value as FontSize)}
            className="input mt-1 w-full"
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pt-5">
          <input
            type="checkbox"
            checked={reduceMotion}
            onChange={(e) => setReduceMotion(e.target.checked)}
          />
          Reduce motion (disable transition animations)
        </label>
      </div>
      <VoiceAudioPreferences />
    </section>
  );
}

function VoiceAudioPreferences(): JSX.Element {
  const noise = usePreferences((s) => s.voiceNoiseSuppression);
  const echo = usePreferences((s) => s.voiceEchoCancellation);
  const gain = usePreferences((s) => s.voiceAutoGain);
  const setNoise = usePreferences((s) => s.setVoiceNoiseSuppression);
  const setEcho = usePreferences((s) => s.setVoiceEchoCancellation);
  const setGain = usePreferences((s) => s.setVoiceAutoGain);
  return (
    <div className="mt-4 border-t border-subtle pt-3">
      <h3 className="text-xs uppercase tracking-wider text-fg-muted">Voice audio</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Browser-level filters applied to your mic. Defaults match what Meet, Teams, and Discord do.
        Changes take effect the next time you join a voice room.
      </p>
      <div className="mt-2 grid gap-2 text-sm md:grid-cols-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={noise}
            onChange={(e) => setNoise(e.target.checked)}
          />
          Noise suppression
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={echo}
            onChange={(e) => setEcho(e.target.checked)}
          />
          Echo cancellation
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={gain}
            onChange={(e) => setGain(e.target.checked)}
          />
          Auto gain
        </label>
      </div>
    </div>
  );
}
