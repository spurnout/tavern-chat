/**
 * Realtime client store.
 *
 * Mirrors the slice of server state we care about for chat: known servers,
 * channels, recent messages per channel, voice presence per channel, and a
 * few convenience selectors.
 *
 * Mutations come from two sources:
 *   1. Direct REST calls (initial fetches, optimistic creates).
 *   2. Gateway dispatches (MESSAGE_CREATE, VOICE_STATE_UPDATE, etc.).
 */

import { create } from 'zustand';
import {
  parsePermissions,
  Permission,
  type Channel,
  type DmChannel,
  type Message,
  type Presence,
  type Role,
  type Server,
  type UserProfile,
  type VoiceStateGatewayPayload,
} from '@tavern/shared';
import { api, ApiError } from './api-client.js';

/**
 * Debounced draft sync. Composer typing fires `setComposerDraft` on every
 * keystroke; we schedule a PUT 1.2s after the last keystroke per channel so
 * cross-device sync converges without hammering the server. An empty content
 * triggers DELETE so we don't leave a stale row behind.
 */
const DRAFT_SYNC_DEBOUNCE_MS = 1200;
const draftSyncTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

function scheduleDraftSync(channelId: string, content: string): void {
  const existing = draftSyncTimers.get(channelId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    draftSyncTimers.delete(channelId);
    const encoded = encodeURIComponent(channelId);
    if (content.length === 0) {
      api(`/me/drafts/${encoded}`, { method: 'DELETE' }).catch(() => undefined);
      return;
    }
    api(`/me/drafts/${encoded}`, {
      method: 'PUT',
      body: { content },
    }).catch(() => undefined);
  }, DRAFT_SYNC_DEBOUNCE_MS);
  draftSyncTimers.set(channelId, timer);
}

/**
 * The voice room the local user is currently in (or trying to enter). Set
 * by the VoicePage on navigation; cleared when the user hangs up. Persists
 * across route changes so the LiveKit session isn't torn down when the
 * user looks at a text channel while still on the call.
 */
export interface CurrentVoice {
  serverId: string;
  channelId: string;
  channelName: string;
}

/**
 * Cached entry for a lazily-fetched user profile. The profile card fetches
 * this on first open; subsequent opens within `PROFILE_TTL_MS` reuse the
 * cached row. `state` differentiates pending requests from successful loads
 * so the UI can show a spinner or an error pane without ambiguity.
 */
export type LoadedProfile =
  | { state: 'loading'; profile: null; fetchedAt: number }
  | { state: 'loaded'; profile: UserProfile; fetchedAt: number }
  | { state: 'error'; profile: null; fetchedAt: number; errorMessage: string }
  | { state: 'unavailable'; profile: null; fetchedAt: number };

export type LoadedRoles =
  | { state: 'loading'; roles: Role[]; fetchedAt: number }
  | { state: 'loaded'; roles: Role[]; fetchedAt: number }
  | { state: 'error'; roles: Role[]; fetchedAt: number };

const PROFILE_TTL_MS = 5 * 60 * 1000;
const ROLES_TTL_MS = 5 * 60 * 1000;
const EMPTY_VOICE_STATES_BY_USER = Object.freeze(
  {},
) as Record<string, VoiceStateGatewayPayload>;

interface RealtimeState {
  serversById: Record<string, Server>;
  channelsByServer: Record<string, Channel[]>;
  messagesByChannel: Record<string, Message[]>;
  /** threadId -> messages array, kept sorted by id like messagesByChannel. */
  messagesByThread: Record<string, Message[]>;
  /** channelId -> map of userId -> last typing timestamp (ms) */
  typingByChannel: Record<string, Record<string, number>>;
  /**
   * channelId -> map of userId -> current voice state. Only contains users
   * actively in the channel; we evict on `channelId: null` updates.
   */
  voiceStatesByChannel: Record<string, Record<string, VoiceStateGatewayPayload>>;
  /** The voice room this client is currently in, or null if hung up. */
  currentVoice: CurrentVoice | null;
  /**
   * Whether the Tavern tab is currently visible and focused. Used by the
   * notification-sound gate to suppress chat sounds when the user is
   * actively looking at the app (and at the relevant channel).
   */
  isAppFocused: boolean;
  /**
   * The channelId the user is currently viewing (from the route), or null
   * if they're on a non-channel route. Lets us tell "they're looking at
   * exactly this channel" from "they're in the app but elsewhere."
   */
  activeChannelId: string | null;
  /** Mirror of `activeChannelId` for DM threads. Mutually exclusive. */
  activeDmChannelId: string | null;
  /**
   * userId -> current presence. Populated from member endpoint responses
   * and kept fresh by PRESENCE_UPDATE dispatches. Missing users default to
   * `'offline'` when read.
   */
  presenceByUserId: Record<string, Presence>;
  /**
   * userId -> live custom status overlay (PF-2 / follow-up #32). Populated
   * by PRESENCE_UPDATE broadcasts whose payload carries the optional
   * `customStatus` / `customStatusExpiresAt` fields. Consumers should prefer
   * this map over the snapshot on `UserProfile` so a status change reflects
   * in the UI without waiting for the next profile re-fetch.
   *
   * `expiresAt` is a `Date` (parsed from the wire ISO string) so consumers
   * can compare against `Date.now()` directly without re-parsing on every
   * render. Missing entries mean "no live signal yet" — fall through to the
   * profile snapshot. An explicit `status: null` means the user CLEARED
   * their status; consumers should render no pill (do NOT fall through).
   */
  customStatusByUserId: Record<
    string,
    { status: string | null; expiresAt: Date | null }
  >;
  /** dmChannelId -> DmChannel; populated by GET /dms and DM_CHANNEL_CREATE. */
  dmChannelsById: Record<string, DmChannel>;
  /**
   * FO-3 — tracks DM channels where the federation delivery failed
   * permanently (all retries exhausted). The DMs view shows a banner for
   * the active channel when its entry is `true`.
   */
  dmFederationRefusedByChannelId: Record<string, boolean>;
  /** dmChannelId -> messages array, kept sorted by id like messagesByChannel. */
  messagesByDmChannel: Record<string, Message[]>;
  /**
   * Cached rich-profile fetches keyed by userId. Populated lazily by the
   * member profile card on first open, refreshed when MEMBER_UPDATE
   * overlays user-level fields.
   */
  profilesByUserId: Record<string, LoadedProfile>;
  /**
   * Cached server role lists keyed by serverId. The profile card maps a
   * member's roleIds over this to render colored role chips.
   */
  rolesByServerId: Record<string, LoadedRoles>;
  /**
   * Per-channel composer drafts. Read by MessageComposer on mount so
   * switching rooms doesn't lose what you were typing, and written from
   * the composer's onChange. Mention injection writes here too.
   */
  composerDraftByChannelId: Record<string, string>;
  /**
   * One-shot "@displayName" injection request keyed by channelId. The
   * MemberProfileCard's "Mention in this room" action writes a non-null
   * value; MessageComposer reacts in a useEffect, appends it to its draft,
   * focuses, then clears the slot.
   */
  pendingMentionByChannelId: Record<string, string | null>;
  /**
   * The calling user's server-level permission bitset (BigInt-as-string),
   * keyed by serverId. Loaded once per server via
   * `GET /api/servers/:id/permissions/me`. UI gates read this to decide
   * whether to show MANAGE_*-fronted affordances without round-tripping.
   */
  myPermissionsByServerId: Record<string, string>;
  /**
   * Per-server nickname overlays applied on top of whatever the initial
   * `GET /servers/:id/members` fetch returned. Populated by MEMBER_UPDATE
   * dispatches so an open sidebar reflects rename events without a refetch.
   * A value of `null` means an explicit "cleared" nickname; `undefined`
   * (the absence of a key) means "no override, use the original".
   */
  nicknameOverridesByServer: Record<string, Record<string, string | null>>;
  /** Wave 2 #4 — link previews keyed by messageId, populated by gateway. */
  linkPreviewsByMessage: Record<string, LinkPreviewDto[]>;
  ready: boolean;
  setReady: (ready: boolean) => void;
  upsertServer: (server: Server) => void;
  removeServer: (serverId: string) => void;
  upsertChannels: (serverId: string, channels: Channel[]) => void;
  upsertChannel: (channel: Channel) => void;
  removeChannel: (channelId: string, serverId?: string) => void;
  setMessages: (channelId: string, messages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  removeMessage: (channelId: string, id: string) => void;
  setThreadMessages: (threadId: string, messages: Message[]) => void;
  upsertThreadMessage: (message: Message) => void;
  removeThreadMessage: (id: string) => void;
  noteTyping: (channelId: string, userId: string, ts: number) => void;
  expireTyping: (channelId: string, before: number) => void;
  applyVoiceState: (state: VoiceStateGatewayPayload) => void;
  setCurrentVoice: (voice: CurrentVoice | null) => void;
  setAppFocused: (focused: boolean) => void;
  setActiveChannelId: (channelId: string | null) => void;
  setActiveDmChannelId: (dmChannelId: string | null) => void;
  setPresence: (userId: string, presence: Presence) => void;
  setPresences: (entries: Record<string, Presence>) => void;
  /**
   * Apply a live custom-status update for `userId`. Pass `status: null` to
   * record an explicit clear (renders no pill); pass a non-null string to
   * set / replace. `expiresAt` is the wall-clock expiry — consumers compare
   * against `Date.now()` on each render. See follow-up #32.
   */
  setCustomStatus: (
    userId: string,
    status: string | null,
    expiresAt: Date | null,
  ) => void;
  upsertDmChannel: (channel: DmChannel) => void;
  removeDmChannel: (channelId: string) => void;
  /** FO-3 — mark a DM channel's federation delivery as permanently refused. */
  setDmFederationRefused: (dmChannelId: string) => void;
  setDmMessages: (dmChannelId: string, messages: Message[]) => void;
  upsertDmMessage: (message: Message) => void;
  removeDmMessage: (dmChannelId: string, id: string) => void;
  applyReaction: (
    op: 'add' | 'remove',
    payload: { messageId: string; userId: string; emoji: string },
    viewerId: string | null,
  ) => void;
  loadProfile: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  setProfile: (userId: string, profile: UserProfile) => void;
  mergeProfileOverlay: (userId: string, overlay: Partial<UserProfile>) => void;
  loadRolesForServer: (serverId: string, opts?: { force?: boolean }) => Promise<void>;
  setComposerDraft: (channelId: string, draft: string) => void;
  /**
   * Bootstrap drafts from the server. Called from AppShell once the user is
   * authenticated so cross-device drafts pick up where they left off.
   */
  loadDrafts: () => Promise<void>;
  /**
   * Drop the local + server-side draft for a channel. Composer calls this
   * after a successful send so a stale draft doesn't reappear on reload.
   */
  clearComposerDraft: (channelId: string) => void;
  queueMention: (channelId: string, displayName: string) => void;
  clearPendingMention: (channelId: string) => void;
  loadMyServerPermissions: (serverId: string, opts?: { force?: boolean }) => Promise<void>;
  setMemberNickname: (serverId: string, userId: string, nickname: string | null) => void;
  setLinkPreviews: (messageId: string, previews: LinkPreviewDto[]) => void;
}

export interface LinkPreviewDto {
  id: string;
  messageId: string;
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: string;
}

function uniqById<T extends { id: string }>(arr: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of arr) seen.set(item.id, item);
  return Array.from(seen.values());
}

function voiceStatesEqual(
  a: VoiceStateGatewayPayload,
  b: VoiceStateGatewayPayload,
): boolean {
  return (
    a.serverId === b.serverId &&
    a.userId === b.userId &&
    a.channelId === b.channelId &&
    a.selfMute === b.selfMute &&
    a.selfDeaf === b.selfDeaf &&
    a.cameraOn === b.cameraOn &&
    a.screenSharing === b.screenSharing &&
    a.joinedAt === b.joinedAt &&
    a.stagePosition === b.stagePosition &&
    a.handRaisedAt === b.handRaisedAt
  );
}

function voiceStateMapsEqual(
  a: Record<string, VoiceStateGatewayPayload> | undefined,
  b: Record<string, VoiceStateGatewayPayload>,
): boolean {
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of bKeys) {
    const left = a?.[key];
    const right = b[key];
    if (!left || !right || !voiceStatesEqual(left, right)) return false;
  }
  return true;
}

export const useRealtime = create<RealtimeState>((set, get) => ({
  serversById: {},
  channelsByServer: {},
  messagesByChannel: {},
  messagesByThread: {},
  typingByChannel: {},
  voiceStatesByChannel: {},
  currentVoice: null,
  isAppFocused: typeof document !== 'undefined' ? !document.hidden : true,
  activeChannelId: null,
  activeDmChannelId: null,
  presenceByUserId: {},
  customStatusByUserId: {},
  dmChannelsById: {},
  dmFederationRefusedByChannelId: {},
  messagesByDmChannel: {},
  profilesByUserId: {},
  rolesByServerId: {},
  composerDraftByChannelId: {},
  pendingMentionByChannelId: {},
  myPermissionsByServerId: {},
  nicknameOverridesByServer: {},
  linkPreviewsByMessage: {},
  ready: false,
  setReady: (ready) => set({ ready }),
  setCurrentVoice: (voice) => set({ currentVoice: voice }),
  setAppFocused: (focused) => set({ isAppFocused: focused }),
  setActiveChannelId: (channelId) => set({ activeChannelId: channelId }),
  setActiveDmChannelId: (dmChannelId) => set({ activeDmChannelId: dmChannelId }),
  setPresence: (userId, presence) =>
    set((s) => ({ presenceByUserId: { ...s.presenceByUserId, [userId]: presence } })),
  setPresences: (entries) =>
    set((s) => ({ presenceByUserId: { ...s.presenceByUserId, ...entries } })),
  setCustomStatus: (userId, status, expiresAt) =>
    set((s) => ({
      customStatusByUserId: {
        ...s.customStatusByUserId,
        [userId]: { status, expiresAt },
      },
    })),

  upsertDmChannel: (channel) =>
    set((s) => ({ dmChannelsById: { ...s.dmChannelsById, [channel.id]: channel } })),
  removeDmChannel: (channelId) =>
    set((s) => {
      const { [channelId]: _gone, ...rest } = s.dmChannelsById;
      const { [channelId]: _msgs, ...restMsgs } = s.messagesByDmChannel;
      const { [channelId]: _refused, ...restRefused } = s.dmFederationRefusedByChannelId;
      return { dmChannelsById: rest, messagesByDmChannel: restMsgs, dmFederationRefusedByChannelId: restRefused };
    }),
  setDmFederationRefused: (dmChannelId) =>
    set((s) => ({
      dmFederationRefusedByChannelId: { ...s.dmFederationRefusedByChannelId, [dmChannelId]: true },
    })),
  setDmMessages: (dmChannelId, messages) =>
    set((s) => ({
      messagesByDmChannel: {
        ...s.messagesByDmChannel,
        [dmChannelId]: [...messages].sort((a, b) => a.id.localeCompare(b.id)),
      },
    })),
  upsertDmMessage: (message) =>
    set((s) => {
      const key = message.dmChannelId;
      if (!key) return s;
      const list = s.messagesByDmChannel[key] ?? [];
      const idx = list.findIndex((m) => m.id === message.id);
      let next: Message[];
      if (idx >= 0) {
        next = [...list];
        next[idx] = message;
      } else {
        next = [...list, message].sort((a, b) => a.id.localeCompare(b.id));
      }
      return {
        messagesByDmChannel: { ...s.messagesByDmChannel, [key]: next },
      };
    }),
  removeDmMessage: (dmChannelId, id) =>
    set((s) => {
      const list = s.messagesByDmChannel[dmChannelId] ?? [];
      return {
        messagesByDmChannel: {
          ...s.messagesByDmChannel,
          [dmChannelId]: list.filter((m) => m.id !== id),
        },
      };
    }),

  applyReaction: (op, { messageId, userId, emoji }, viewerId) =>
    set((s) => {
      const isViewer = viewerId !== null && userId === viewerId;
      function patch(msg: Message): Message {
        const idx = msg.reactions.findIndex((r) => r.emoji === emoji);
        if (op === 'add') {
          if (idx < 0) {
            return {
              ...msg,
              reactions: [...msg.reactions, { emoji, count: 1, me: isViewer }],
            };
          }
          const existing = msg.reactions[idx];
          if (!existing) return msg;
          if (isViewer && existing.me) return msg;
          const next = [...msg.reactions];
          next[idx] = {
            emoji: existing.emoji,
            count: existing.count + 1,
            me: existing.me || isViewer,
          };
          return { ...msg, reactions: next };
        }
        if (idx < 0) return msg;
        const existing = msg.reactions[idx];
        if (!existing) return msg;
        const nextCount = Math.max(0, existing.count - 1);
        const nextMe = isViewer ? false : existing.me;
        if (nextCount === 0) {
          return { ...msg, reactions: msg.reactions.filter((_, i) => i !== idx) };
        }
        const next = [...msg.reactions];
        next[idx] = { emoji: existing.emoji, count: nextCount, me: nextMe };
        return { ...msg, reactions: next };
      }

      const updates: Partial<RealtimeState> = {};
      for (const [channelId, list] of Object.entries(s.messagesByChannel)) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) continue;
        const current = list[idx];
        if (!current) continue;
        const next = [...list];
        next[idx] = patch(current);
        updates.messagesByChannel = {
          ...(updates.messagesByChannel ?? s.messagesByChannel),
          [channelId]: next,
        };
        break;
      }
      for (const [threadId, list] of Object.entries(s.messagesByThread)) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) continue;
        const current = list[idx];
        if (!current) continue;
        const next = [...list];
        next[idx] = patch(current);
        updates.messagesByThread = {
          ...(updates.messagesByThread ?? s.messagesByThread),
          [threadId]: next,
        };
        break;
      }
      for (const [dmChannelId, list] of Object.entries(s.messagesByDmChannel)) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) continue;
        const current = list[idx];
        if (!current) continue;
        const next = [...list];
        next[idx] = patch(current);
        updates.messagesByDmChannel = {
          ...(updates.messagesByDmChannel ?? s.messagesByDmChannel),
          [dmChannelId]: next,
        };
        break;
      }
      return updates;
    }),

  noteTyping: (channelId, userId, ts) =>
    set((s) => ({
      typingByChannel: {
        ...s.typingByChannel,
        [channelId]: { ...(s.typingByChannel[channelId] ?? {}), [userId]: ts },
      },
    })),
  expireTyping: (channelId, before) =>
    set((s) => {
      const current = s.typingByChannel[channelId] ?? {};
      const next: Record<string, number> = {};
      for (const [uid, ts] of Object.entries(current)) {
        if (ts >= before) next[uid] = ts;
      }
      return {
        typingByChannel: { ...s.typingByChannel, [channelId]: next },
      };
    }),

  upsertServer: (server) =>
    set((s) => ({ serversById: { ...s.serversById, [server.id]: server } })),

  // P4-16 — splice a server out of the in-memory store. Called from the
  // SERVER_REMOVE gateway handler (mirror tear-down on leave). We also drop
  // the per-server channel list so the next paint doesn't briefly render
  // stale rooms if the user navigates back. The deletes are immutable —
  // copy + omit rather than mutate-in-place to keep useSyncExternalStore
  // selectors honest.
  removeServer: (serverId) =>
    set((s) => {
      const { [serverId]: _removedServer, ...nextServers } = s.serversById;
      const { [serverId]: _removedChannels, ...nextChannels } = s.channelsByServer;
      return { serversById: nextServers, channelsByServer: nextChannels };
    }),

  upsertChannels: (serverId, channels) =>
    set((s) => {
      let voiceStatesByChannel = s.voiceStatesByChannel;
      for (const channel of channels) {
        if (channel.voiceStates === undefined) continue;
        const nextByUser: Record<string, VoiceStateGatewayPayload> = {};
        for (const state of channel.voiceStates) {
          if (state.channelId === channel.id) nextByUser[state.userId] = state;
        }
        if (voiceStateMapsEqual(voiceStatesByChannel[channel.id], nextByUser)) {
          continue;
        }
        if (voiceStatesByChannel === s.voiceStatesByChannel) {
          voiceStatesByChannel = { ...s.voiceStatesByChannel };
        }
        voiceStatesByChannel[channel.id] = nextByUser;
      }
      return {
        channelsByServer: {
          ...s.channelsByServer,
          [serverId]: [...channels].sort((a, b) => a.position - b.position),
        },
        voiceStatesByChannel,
      };
    }),

  upsertChannel: (channel) =>
    set((s) => {
      const list = s.channelsByServer[channel.serverId] ?? [];
      const next = uniqById([channel, ...list]).sort((a, b) => a.position - b.position);
      return {
        channelsByServer: { ...s.channelsByServer, [channel.serverId]: next },
      };
    }),

  removeChannel: (channelId, serverId) =>
    set((s) => {
      const candidates = serverId
        ? { [serverId]: s.channelsByServer[serverId] ?? [] }
        : s.channelsByServer;
      const next: Record<string, Channel[]> = { ...s.channelsByServer };
      for (const [sid, list] of Object.entries(candidates)) {
        next[sid] = list.filter((c) => c.id !== channelId);
      }
      return { channelsByServer: next };
    }),

  setMessages: (channelId, messages) =>
    set((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: messages
          .filter((m) => !m.threadId)
          .sort((a, b) => a.id.localeCompare(b.id)),
      },
    })),

  upsertMessage: (message) =>
    set((s) => {
      // upsertMessage handles server-channel messages only; DM messages
      // come through upsertDmMessage and thread replies come through
      // upsertThreadMessage. Skip null-channelId rows defensively.
      const key = message.channelId;
      if (!key || message.threadId) return s;
      const list = s.messagesByChannel[key] ?? [];
      const idx = list.findIndex((m) => m.id === message.id);
      let next: Message[];
      if (idx >= 0) {
        next = [...list];
        next[idx] = message;
      } else {
        next = [...list, message].sort((a, b) => a.id.localeCompare(b.id));
      }
      return {
        messagesByChannel: { ...s.messagesByChannel, [key]: next },
      };
    }),

  removeMessage: (channelId, id) =>
    set((s) => {
      const list = s.messagesByChannel[channelId] ?? [];
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: list.filter((m) => m.id !== id),
        },
      };
    }),

  setThreadMessages: (threadId, messages) =>
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...messages].sort((a, b) => a.id.localeCompare(b.id)),
      },
    })),

  upsertThreadMessage: (message) =>
    set((s) => {
      const key = message.threadId;
      if (!key) return s;
      const list = s.messagesByThread[key] ?? [];
      const idx = list.findIndex((m) => m.id === message.id);
      let next: Message[];
      if (idx >= 0) {
        next = [...list];
        next[idx] = message;
      } else {
        next = [...list, message].sort((a, b) => a.id.localeCompare(b.id));
      }
      return {
        messagesByThread: { ...s.messagesByThread, [key]: next },
      };
    }),

  removeThreadMessage: (id) =>
    set((s) => {
      let changed = false;
      const next: Record<string, Message[]> = {};
      for (const [threadId, list] of Object.entries(s.messagesByThread)) {
        const filtered = list.filter((m) => m.id !== id);
        next[threadId] = filtered;
        if (filtered.length !== list.length) changed = true;
      }
      return changed ? { messagesByThread: next } : s;
    }),

  setProfile: (userId, profile) =>
    set((s) => ({
      profilesByUserId: {
        ...s.profilesByUserId,
        [userId]: { state: 'loaded', profile, fetchedAt: Date.now() },
      },
    })),

  mergeProfileOverlay: (userId, overlay) =>
    set((s) => {
      const current = s.profilesByUserId[userId];
      if (!current || current.state !== 'loaded') return s;
      const merged: UserProfile = { ...current.profile, ...overlay };
      return {
        profilesByUserId: {
          ...s.profilesByUserId,
          [userId]: { state: 'loaded', profile: merged, fetchedAt: current.fetchedAt },
        },
      };
    }),

  loadProfile: async (userId, opts) => {
    const force = opts?.force === true;
    const cached = get().profilesByUserId[userId];
    if (
      !force &&
      cached &&
      cached.state === 'loaded' &&
      Date.now() - cached.fetchedAt < PROFILE_TTL_MS
    ) {
      return;
    }
    if (!force && cached && cached.state === 'loading') return;
    set((s) => ({
      profilesByUserId: {
        ...s.profilesByUserId,
        [userId]: { state: 'loading', profile: null, fetchedAt: Date.now() },
      },
    }));
    try {
      const profile = await api<UserProfile>(`/users/${userId}/profile`);
      set((s) => ({
        profilesByUserId: {
          ...s.profilesByUserId,
          [userId]: { state: 'loaded', profile, fetchedAt: Date.now() },
        },
      }));
    } catch (err) {
      const unavailable = err instanceof ApiError && err.status === 404;
      const message =
        err instanceof ApiError ? err.message : 'Could not load profile.';
      set((s) => ({
        profilesByUserId: {
          ...s.profilesByUserId,
          [userId]: unavailable
            ? { state: 'unavailable', profile: null, fetchedAt: Date.now() }
            : { state: 'error', profile: null, fetchedAt: Date.now(), errorMessage: message },
        },
      }));
    }
  },

  loadRolesForServer: async (serverId, opts) => {
    const force = opts?.force === true;
    const cached = get().rolesByServerId[serverId];
    if (
      !force &&
      cached &&
      cached.state === 'loaded' &&
      Date.now() - cached.fetchedAt < ROLES_TTL_MS
    ) {
      return;
    }
    if (!force && cached && cached.state === 'loading') return;
    set((s) => ({
      rolesByServerId: {
        ...s.rolesByServerId,
        [serverId]: {
          state: 'loading',
          roles: cached?.roles ?? [],
          fetchedAt: Date.now(),
        },
      },
    }));
    try {
      const roles = await api<Role[]>(`/servers/${serverId}/roles`);
      set((s) => ({
        rolesByServerId: {
          ...s.rolesByServerId,
          [serverId]: { state: 'loaded', roles, fetchedAt: Date.now() },
        },
      }));
    } catch {
      set((s) => ({
        rolesByServerId: {
          ...s.rolesByServerId,
          [serverId]: {
            state: 'error',
            roles: cached?.roles ?? [],
            fetchedAt: Date.now(),
          },
        },
      }));
    }
  },

  loadDrafts: async () => {
    try {
      const rows = await api<Array<{ channelId: string; content: string }>>(
        '/me/drafts',
      );
      const map: Record<string, string> = {};
      for (const r of rows) {
        if (r.content) map[r.channelId] = r.content;
      }
      set({ composerDraftByChannelId: map });
    } catch {
      // Drafts are a polish feature — never block UI on a failure.
    }
  },
  clearComposerDraft: (channelId) => {
    set((s) => {
      const { [channelId]: _, ...rest } = s.composerDraftByChannelId;
      return { composerDraftByChannelId: rest };
    });
    scheduleDraftSync(channelId, '');
  },
  setComposerDraft: (channelId, draft) => {
    scheduleDraftSync(channelId, draft);
    set((s) => ({
      composerDraftByChannelId: { ...s.composerDraftByChannelId, [channelId]: draft },
    }));
  },

  queueMention: (channelId, displayName) =>
    set((s) => ({
      pendingMentionByChannelId: {
        ...s.pendingMentionByChannelId,
        [channelId]: displayName,
      },
    })),

  clearPendingMention: (channelId) =>
    set((s) => ({
      pendingMentionByChannelId: { ...s.pendingMentionByChannelId, [channelId]: null },
    })),

  setLinkPreviews: (messageId, previews) =>
    set((s) => ({
      linkPreviewsByMessage: { ...s.linkPreviewsByMessage, [messageId]: previews },
    })),
  setMemberNickname: (serverId, userId, nickname) =>
    set((s) => ({
      nicknameOverridesByServer: {
        ...s.nicknameOverridesByServer,
        [serverId]: {
          ...(s.nicknameOverridesByServer[serverId] ?? {}),
          [userId]: nickname,
        },
      },
    })),

  loadMyServerPermissions: async (serverId, opts) => {
    const force = opts?.force === true;
    const cached = get().myPermissionsByServerId[serverId];
    if (!force && cached !== undefined) return;
    try {
      const res = await api<{ serverId: string; permissions: string }>(
        `/servers/${serverId}/permissions/me`,
      );
      set((s) => ({
        myPermissionsByServerId: {
          ...s.myPermissionsByServerId,
          [serverId]: res.permissions,
        },
      }));
    } catch {
      // On error, write "0" so future reads short-circuit to "no perms"
      // without re-trying on every render. A SERVER_UPDATE / re-login
      // can refresh it.
      set((s) => ({
        myPermissionsByServerId: { ...s.myPermissionsByServerId, [serverId]: '0' },
      }));
    }
  },

  applyVoiceState: (state) =>
    set((s) => {
      // Two-pass immutable update: evict the user from every prior channel,
      // then place them in the new one (if any). Voice presence is
      // single-channel per user; mutating a freshly-spread copy in place
      // would break the project's immutability rule.
      const evicted: Record<string, Record<string, VoiceStateGatewayPayload>> = {};
      for (const [chId, byUser] of Object.entries(s.voiceStatesByChannel)) {
        if (byUser[state.userId]) {
          const { [state.userId]: _gone, ...rest } = byUser;
          evicted[chId] = rest;
        } else {
          evicted[chId] = byUser;
        }
      }
      if (state.channelId === null) {
        return { voiceStatesByChannel: evicted };
      }
      const byUser = evicted[state.channelId] ?? {};
      return {
        voiceStatesByChannel: {
          ...evicted,
          [state.channelId]: { ...byUser, [state.userId]: state },
        },
      };
    }),
}));

export function useVoiceStatesForChannel(
  channelId: string | null | undefined,
): Record<string, VoiceStateGatewayPayload> {
  return useRealtime((s) => {
    if (!channelId) return EMPTY_VOICE_STATES_BY_USER;
    return s.voiceStatesByChannel[channelId] ?? EMPTY_VOICE_STATES_BY_USER;
  });
}

/**
 * Whether the calling user holds `flag` on `serverId`. Returns false while
 * the permission bitset for the server is still being loaded; consumers
 * should call `loadMyServerPermissions(serverId)` on mount to ensure the
 * cache is warm.
 */
export function useCanIn(serverId: string | null | undefined, flag: bigint): boolean {
  return useRealtime((s) => {
    if (!serverId) return false;
    const cached = s.myPermissionsByServerId[serverId];
    if (cached === undefined) return false;
    const perms = parsePermissions(cached);
    // ADMINISTRATOR bypass mirrors the server-side `can()` semantics.
    if ((perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
    return (perms & flag) === flag;
  });
}

/**
 * True iff at least one participant in `channelId` is currently screen-sharing.
 * Returns a boolean so consumers don't have to worry about array-identity
 * stability across renders.
 */
export function useAnyScreenSharing(channelId: string | null | undefined): boolean {
  return useRealtime((s) => {
    if (!channelId) return false;
    const byUser = s.voiceStatesByChannel[channelId];
    if (!byUser) return false;
    for (const state of Object.values(byUser)) {
      if (state.screenSharing) return true;
    }
    return false;
  });
}
