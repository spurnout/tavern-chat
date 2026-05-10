/**
 * Realtime client store.
 *
 * Mirrors the slice of server state we care about for chat: known servers,
 * channels, recent messages per channel, and a few convenience selectors.
 *
 * Mutations come from two sources:
 *   1. Direct REST calls (initial fetches, optimistic creates).
 *   2. Gateway dispatches (MESSAGE_CREATE, etc.).
 */

import { create } from 'zustand';
import type { Channel, Message, Server } from '@tavern/shared';

interface RealtimeState {
  serversById: Record<string, Server>;
  channelsByServer: Record<string, Channel[]>;
  messagesByChannel: Record<string, Message[]>;
  /** channelId -> map of userId -> last typing timestamp (ms) */
  typingByChannel: Record<string, Record<string, number>>;
  ready: boolean;
  setReady: (ready: boolean) => void;
  upsertServer: (server: Server) => void;
  upsertChannels: (serverId: string, channels: Channel[]) => void;
  upsertChannel: (channel: Channel) => void;
  removeChannel: (channelId: string, serverId?: string) => void;
  setMessages: (channelId: string, messages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  removeMessage: (channelId: string, id: string) => void;
  noteTyping: (channelId: string, userId: string, ts: number) => void;
  expireTyping: (channelId: string, before: number) => void;
}

function uniqById<T extends { id: string }>(arr: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of arr) seen.set(item.id, item);
  return Array.from(seen.values());
}

export const useRealtime = create<RealtimeState>((set) => ({
  serversById: {},
  channelsByServer: {},
  messagesByChannel: {},
  typingByChannel: {},
  ready: false,
  setReady: (ready) => set({ ready }),

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

  upsertChannels: (serverId, channels) =>
    set((s) => ({
      channelsByServer: {
        ...s.channelsByServer,
        [serverId]: [...channels].sort((a, b) => a.position - b.position),
      },
    })),

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
        [channelId]: [...messages].sort((a, b) => a.id.localeCompare(b.id)),
      },
    })),

  upsertMessage: (message) =>
    set((s) => {
      const list = s.messagesByChannel[message.channelId] ?? [];
      const idx = list.findIndex((m) => m.id === message.id);
      let next: Message[];
      if (idx >= 0) {
        next = [...list];
        next[idx] = message;
      } else {
        next = [...list, message].sort((a, b) => a.id.localeCompare(b.id));
      }
      return {
        messagesByChannel: { ...s.messagesByChannel, [message.channelId]: next },
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
}));
