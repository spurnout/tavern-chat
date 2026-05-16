import { create } from 'zustand';
import type {
  ServerMemberNotificationPreference,
  UpdateServerMemberNotificationPreferenceRequest,
  UpdateUserNotificationPreferenceRequest,
  UserNotificationPreference,
} from '@tavern/shared';
import { api } from './api-client.js';
import { setSoundSettingsReader } from './sound.js';

const GLOBAL_DEFAULTS: UserNotificationPreference = {
  soundEnabled: true,
  volume: 70,
  chatSoundsWhileInVoice: false,
  playOnlyWhenUnfocused: true,
  mentionsOverrideMute: true,
};

interface NotificationSettingsState {
  global: UserNotificationPreference;
  perTavern: Record<string, ServerMemberNotificationPreference>;
  loaded: boolean;
  loadGlobal: () => Promise<void>;
  loadPerTavern: (serverId: string) => Promise<void>;
  updateGlobal: (patch: UpdateUserNotificationPreferenceRequest) => Promise<void>;
  updatePerTavern: (
    serverId: string,
    patch: UpdateServerMemberNotificationPreferenceRequest,
  ) => Promise<void>;
}

export const useNotificationSettings = create<NotificationSettingsState>((set, get) => ({
  global: GLOBAL_DEFAULTS,
  perTavern: {},
  loaded: false,

  loadGlobal: async () => {
    try {
      const prefs = await api<UserNotificationPreference>('/me/notification-preferences');
      set({ global: prefs, loaded: true });
    } catch {
      // Stay on defaults; the panel will work optimistically against the
      // server later. Don't surface this — it would clutter the boot UI for
      // a non-critical feature.
      set({ loaded: true });
    }
  },

  loadPerTavern: async (serverId) => {
    try {
      const prefs = await api<ServerMemberNotificationPreference>(
        `/servers/${serverId}/notification-preferences/me`,
      );
      set((s) => ({ perTavern: { ...s.perTavern, [serverId]: prefs } }));
    } catch {
      // Same rationale as loadGlobal.
    }
  },

  updateGlobal: async (patch) => {
    // Optimistic local apply so the slider/toggle is instant.
    set((s) => ({ global: { ...s.global, ...patch } }));
    try {
      const next = await api<UserNotificationPreference>('/me/notification-preferences', {
        method: 'PATCH',
        body: patch,
      });
      set({ global: next });
    } catch {
      // Refetch to recover from divergence on failure.
      await get().loadGlobal();
    }
  },

  updatePerTavern: async (serverId, patch) => {
    set((s) => {
      const existing =
        s.perTavern[serverId] ??
        ({
          serverId,
          muteAll: false,
          muteMessages: false,
          muteMentions: false,
        } as ServerMemberNotificationPreference);
      return {
        perTavern: { ...s.perTavern, [serverId]: { ...existing, ...patch } },
      };
    });
    try {
      const next = await api<ServerMemberNotificationPreference>(
        `/servers/${serverId}/notification-preferences/me`,
        { method: 'PATCH', body: patch },
      );
      set((s) => ({ perTavern: { ...s.perTavern, [serverId]: next } }));
    } catch {
      await get().loadPerTavern(serverId);
    }
  },
}));

/**
 * Wire the notification settings store as the source for the sound engine's
 * global mute + volume. Call once at app boot, after the auth state has
 * settled. Idempotent.
 */
export function bindSoundSettings(): void {
  setSoundSettingsReader(() => {
    const { global } = useNotificationSettings.getState();
    return {
      enabled: global.soundEnabled,
      volume: global.volume / 100,
    };
  });
}
