import { create } from 'zustand';
import { api } from './api-client.js';

export interface ChannelReadState {
  channelId: string;
  lastReadMessageId: string | null;
  lastReadAt: string;
  mentionCount: number;
}

export interface InboxItem {
  id: string;
  kind: 'user' | 'role' | 'everyone' | 'here';
  isRead: boolean;
  createdAt: string;
  channelId: string | null;
  dmChannelId: string | null;
  message: {
    id: string;
    channelId: string | null;
    dmChannelId: string | null;
    authorId: string;
    authorDisplayName: string;
    content: string;
    createdAt: string;
  };
}

interface AckResponse {
  channelId: string;
  lastReadMessageId: string | null;
  lastReadAt: string;
  mentionCount: number;
}

interface InboxState {
  readStatesByChannel: Record<string, ChannelReadState>;
  inboxItems: InboxItem[];
  inboxLoaded: boolean;
  inboxLoading: boolean;
  /** Sum of unread mention counts across all channels — the bell badge total. */
  totalUnreadMentions: number;

  hydrateReadStates: () => Promise<void>;
  applyAck: (state: ChannelReadState) => void;
  ackChannel: (channelId: string, lastMessageId: string) => Promise<void>;
  loadInbox: (force?: boolean) => Promise<void>;
  ackMention: (mentionId: string) => Promise<void>;
  ackAllMentions: () => Promise<void>;
  onMentionCreate: (item: InboxItem) => void;
}

function recomputeTotal(states: Record<string, ChannelReadState>): number {
  let total = 0;
  for (const s of Object.values(states)) total += s.mentionCount;
  return total;
}

export const useInbox = create<InboxState>((set, get) => ({
  readStatesByChannel: {},
  inboxItems: [],
  inboxLoaded: false,
  inboxLoading: false,
  totalUnreadMentions: 0,

  hydrateReadStates: async () => {
    try {
      const states = await api<ChannelReadState[]>('/me/read-states');
      const byChannel: Record<string, ChannelReadState> = {};
      for (const s of states) byChannel[s.channelId] = s;
      set({
        readStatesByChannel: byChannel,
        totalUnreadMentions: recomputeTotal(byChannel),
      });
    } catch {
      // Silent fail — bell will just show 0 until next attempt.
    }
  },

  applyAck: (state) => {
    set((s) => {
      const next = { ...s.readStatesByChannel, [state.channelId]: state };
      return {
        readStatesByChannel: next,
        totalUnreadMentions: recomputeTotal(next),
        inboxItems: s.inboxItems.map((m) =>
          m.channelId === state.channelId && !m.isRead ? { ...m, isRead: true } : m,
        ),
      };
    });
  },

  ackChannel: async (channelId, lastMessageId) => {
    const current = get().readStatesByChannel[channelId];
    if (current && current.lastReadMessageId === lastMessageId) return;
    try {
      const result = await api<AckResponse>(`/channels/${channelId}/ack`, {
        method: 'POST',
        body: { lastReadMessageId: lastMessageId },
      });
      get().applyAck({
        channelId,
        lastReadMessageId: result.lastReadMessageId,
        lastReadAt: result.lastReadAt,
        mentionCount: result.mentionCount,
      });
    } catch {
      // Silently ignore — next ack attempt will catch up.
    }
  },

  loadInbox: async (force) => {
    if (!force && get().inboxLoaded) return;
    set({ inboxLoading: true });
    try {
      const res = await api<{ items: InboxItem[]; nextCursor: string | null }>(
        '/me/inbox?filter=unread',
      );
      set({ inboxItems: res.items, inboxLoaded: true });
    } catch {
      set({ inboxItems: [] });
    } finally {
      set({ inboxLoading: false });
    }
  },

  ackMention: async (mentionId) => {
    const item = get().inboxItems.find((m) => m.id === mentionId);
    if (!item || item.isRead) return;
    try {
      await api(`/me/inbox/${mentionId}/ack`, { method: 'POST' });
      set((s) => ({
        inboxItems: s.inboxItems.map((m) => (m.id === mentionId ? { ...m, isRead: true } : m)),
        readStatesByChannel: item.channelId
          ? {
              ...s.readStatesByChannel,
              [item.channelId]: {
                channelId: item.channelId,
                lastReadMessageId: s.readStatesByChannel[item.channelId]?.lastReadMessageId ?? null,
                lastReadAt:
                  s.readStatesByChannel[item.channelId]?.lastReadAt ?? new Date().toISOString(),
                mentionCount: Math.max(
                  0,
                  (s.readStatesByChannel[item.channelId]?.mentionCount ?? 0) - 1,
                ),
              },
            }
          : s.readStatesByChannel,
      }));
      set((s) => ({ totalUnreadMentions: recomputeTotal(s.readStatesByChannel) }));
    } catch {
      // Ignore — UI is best-effort.
    }
  },

  ackAllMentions: async () => {
    try {
      await api('/me/inbox/ack-all', { method: 'POST' });
      set((s) => {
        const next: Record<string, ChannelReadState> = {};
        for (const [k, v] of Object.entries(s.readStatesByChannel)) {
          next[k] = { ...v, mentionCount: 0 };
        }
        return {
          readStatesByChannel: next,
          totalUnreadMentions: 0,
          inboxItems: s.inboxItems.map((m) => ({ ...m, isRead: true })),
        };
      });
    } catch {
      // Ignore.
    }
  },

  onMentionCreate: (item) => {
    set((s) => {
      const channelId = item.channelId;
      let nextStates = s.readStatesByChannel;
      if (channelId) {
        const existing = s.readStatesByChannel[channelId];
        nextStates = {
          ...s.readStatesByChannel,
          [channelId]: {
            channelId,
            lastReadMessageId: existing?.lastReadMessageId ?? null,
            lastReadAt: existing?.lastReadAt ?? new Date(0).toISOString(),
            mentionCount: (existing?.mentionCount ?? 0) + 1,
          },
        };
      }
      return {
        readStatesByChannel: nextStates,
        totalUnreadMentions: recomputeTotal(nextStates),
        inboxItems: [item, ...s.inboxItems].slice(0, 200),
      };
    });
  },
}));
