import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Wave 3 #30 / #33 — local appearance preferences. Persisted client-side
 * in localStorage so they apply instantly on first paint. The server
 * mirrors the same fields on User (themePreference/fontPreference/
 * reduceMotion/localePreference) for cross-device sync; the client
 * hydrates from the server on /auth/me load (deferred for the MVP).
 */

export type ThemeName = 'tavern' | 'dark' | 'sepia' | 'highContrast';
export type FontName = 'serif' | 'sans' | 'dyslexia';
export type FontSize = 'small' | 'medium' | 'large';

interface PreferencesState {
  theme: ThemeName;
  font: FontName;
  size: FontSize;
  reduceMotion: boolean;
  /**
   * Wave 3 #30 — browser-level noise suppression. Forwarded into
   * getUserMedia constraints when joining a voice room. Browsers run
   * their own RNNoise-equivalent on the mic stream before LiveKit ever
   * sees it; no Tavern-side WASM required.
   */
  voiceNoiseSuppression: boolean;
  voiceEchoCancellation: boolean;
  voiceAutoGain: boolean;
  setTheme: (theme: ThemeName) => void;
  setFont: (font: FontName) => void;
  setSize: (size: FontSize) => void;
  setReduceMotion: (rm: boolean) => void;
  setVoiceNoiseSuppression: (on: boolean) => void;
  setVoiceEchoCancellation: (on: boolean) => void;
  setVoiceAutoGain: (on: boolean) => void;
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'tavern',
      font: 'serif',
      size: 'medium',
      reduceMotion: false,
      voiceNoiseSuppression: true,
      voiceEchoCancellation: true,
      voiceAutoGain: true,
      setTheme: (theme) => set({ theme }),
      setFont: (font) => set({ font }),
      setSize: (size) => set({ size }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setVoiceNoiseSuppression: (voiceNoiseSuppression) => set({ voiceNoiseSuppression }),
      setVoiceEchoCancellation: (voiceEchoCancellation) => set({ voiceEchoCancellation }),
      setVoiceAutoGain: (voiceAutoGain) => set({ voiceAutoGain }),
    }),
    { name: 'tavern.preferences' },
  ),
);

/**
 * Apply preferences to the document root. Call once on app boot and
 * whenever the user changes a setting. Drives CSS by way of data-attrs.
 */
export function applyPreferencesToDom(): () => void {
  const apply = (s: PreferencesState): void => {
    const html = document.documentElement;
    html.dataset['theme'] = s.theme;
    html.dataset['font'] = s.font;
    html.dataset['size'] = s.size;
    html.dataset['reduceMotion'] = s.reduceMotion ? 'true' : 'false';
  };
  apply(usePreferences.getState());
  return usePreferences.subscribe(apply);
}
