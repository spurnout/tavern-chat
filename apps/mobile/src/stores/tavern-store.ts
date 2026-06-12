import { create } from 'zustand';
import type {
  Channel,
  GatewayDispatchEventName,
  Message,
  Server,
} from '@tavern/shared/schemas';
import { buildGatewayUrl } from '@/lib/api-client';
import { GatewayClient, type GatewayStatus } from '@/lib/gateway-client';
import { useAuthStore } from '@/stores/auth-store';

interface ReadyPayload {
  user: { id: string };
  servers: Array<{
    id: string;
    name: string;
    ownerUserId: string;
    iconAttachmentId: string | null;
    defaultRoleId: string | null;
    federationEnabled?: boolean;
    originInstanceId?: string | null;
    originInstanceHost?: string | null;
  }>;
}

interface TavernState {
  gatewayStatus: GatewayStatus;
  activeServerId: string | null;
  activeChannelId: string | null;
  serversById: Record<string, Server>;
  channelsByServer: Record<string, Channel[]>;
  messagesByChannel: Record<string, Message[]>;
  loadingServers: boolean;
  loadingChannelsByServer: Record<string, boolean>;
  loadingMessagesByChannel: Record<string, boolean>;
  error: string | null;
  setGatewayStatus: (status: GatewayStatus) => void;
  startRealtime: () => void;
  stopRealtime: () => void;
  loadServers: () => Promise<void>;
  selectServer: (serverId: string) => Promise<void>;
  selectChannel: (channelId: string) => Promise<void>;
  clearChannel: () => void;
  loadMessages: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<void>;
  handleDispatch: (event: GatewayDispatchEventName, data: unknown) => void;
  reset: () => void;
}

let gatewayClient: GatewayClient | null = null;

export const useTavernStore = create<TavernState>((set, get) => ({
  gatewayStatus: 'idle',
  activeServerId: null,
  activeChannelId: null,
  serversById: {},
  channelsByServer: {},
  messagesByChannel: {},
  loadingServers: false,
  loadingChannelsByServer: {},
  loadingMessagesByChannel: {},
  error: null,

  setGatewayStatus: (gatewayStatus) => set({ gatewayStatus }),

  startRealtime: () => {
    if (gatewayClient) return;
    const auth = useAuthStore.getState();
    if (!auth.instanceUrl || !auth.accessToken) return;
    gatewayClient = new GatewayClient({
      url: buildGatewayUrl(auth.instanceUrl),
      getAccessToken: () => useAuthStore.getState().accessToken,
      onStatusChange: (status) => get().setGatewayStatus(status),
      onDispatch: (event, data) => get().handleDispatch(event, data),
    });
    gatewayClient.connect();
  },

  stopRealtime: () => {
    gatewayClient?.close();
    gatewayClient = null;
    set({ gatewayStatus: 'closed' });
  },

  loadServers: async () => {
    set({ loadingServers: true, error: null });
    try {
      const servers = await useAuthStore.getState().api<Server[]>('/servers');
      set((state) => {
        const serversById = { ...state.serversById };
        for (const server of servers) serversById[server.id] = server;
        const activeServerId = state.activeServerId ?? servers[0]?.id ?? null;
        return { serversById, activeServerId, loadingServers: false };
      });
      const active = get().activeServerId;
      if (active) await get().selectServer(active);
    } catch (err) {
      set({ loadingServers: false, error: messageFrom(err, 'Could not load taverns.') });
    }
  },

  selectServer: async (serverId) => {
    set({ activeServerId: serverId, activeChannelId: null, error: null });
    const existing = get().channelsByServer[serverId];
    if (existing) return;
    set((state) => ({
      loadingChannelsByServer: { ...state.loadingChannelsByServer, [serverId]: true },
    }));
    try {
      const channels = await useAuthStore
        .getState()
        .api<Channel[]>(`/servers/${serverId}/channels`);
      set((state) => ({
        channelsByServer: { ...state.channelsByServer, [serverId]: channels },
        loadingChannelsByServer: { ...state.loadingChannelsByServer, [serverId]: false },
      }));
    } catch (err) {
      set((state) => ({
        error: messageFrom(err, 'Could not load rooms.'),
        loadingChannelsByServer: { ...state.loadingChannelsByServer, [serverId]: false },
      }));
    }
  },

  selectChannel: async (channelId) => {
    set({ activeChannelId: channelId, error: null });
    await get().loadMessages(channelId);
  },

  clearChannel: () => set({ activeChannelId: null }),

  loadMessages: async (channelId) => {
    set((state) => ({
      loadingMessagesByChannel: { ...state.loadingMessagesByChannel, [channelId]: true },
    }));
    try {
      const messages = await useAuthStore
        .getState()
        .api<Message[]>(`/channels/${channelId}/messages`, { query: { limit: 50 } });
      set((state) => ({
        messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
        loadingMessagesByChannel: {
          ...state.loadingMessagesByChannel,
          [channelId]: false,
        },
      }));
    } catch (err) {
      set((state) => ({
        error: messageFrom(err, 'Could not load messages.'),
        loadingMessagesByChannel: {
          ...state.loadingMessagesByChannel,
          [channelId]: false,
        },
      }));
    }
  },

  sendMessage: async (channelId, content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const message = await useAuthStore.getState().api<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: trimmed, nonce },
    });
    set((state) => ({
      messagesByChannel: {
        ...state.messagesByChannel,
        [channelId]: upsertMessage(state.messagesByChannel[channelId] ?? [], message),
      },
    }));
  },

  handleDispatch: (event, data) => {
    switch (event) {
      case 'READY': {
        const ready = data as ReadyPayload;
        set((state) => {
          const serversById = { ...state.serversById };
          for (const server of ready.servers) {
            serversById[server.id] = {
              ...serverFromReady(server),
              ...serversById[server.id],
            };
          }
          return {
            serversById,
            activeServerId: state.activeServerId ?? ready.servers[0]?.id ?? null,
          };
        });
        return;
      }
      case 'SERVER_ADD':
      case 'SERVER_UPDATE':
        set((state) => ({
          serversById: {
            ...state.serversById,
            [(data as Server).id]: data as Server,
          },
        }));
        return;
      case 'SERVER_REMOVE': {
        const serverId = (data as { serverId: string }).serverId;
        set((state) => {
          const serversById = { ...state.serversById };
          const channelsByServer = { ...state.channelsByServer };
          delete serversById[serverId];
          delete channelsByServer[serverId];
          return {
            serversById,
            channelsByServer,
            activeServerId: state.activeServerId === serverId ? null : state.activeServerId,
          };
        });
        return;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const channel = data as Channel;
        set((state) => ({
          channelsByServer: {
            ...state.channelsByServer,
            [channel.serverId]: upsertChannel(state.channelsByServer[channel.serverId] ?? [], channel),
          },
        }));
        return;
      }
      case 'CHANNEL_DELETE': {
        const channelId = (data as { id: string }).id;
        set((state) => {
          const channelsByServer: Record<string, Channel[]> = {};
          for (const [serverId, channels] of Object.entries(state.channelsByServer)) {
            channelsByServer[serverId] = channels.filter((channel) => channel.id !== channelId);
          }
          return {
            channelsByServer,
            activeChannelId: state.activeChannelId === channelId ? null : state.activeChannelId,
          };
        });
        return;
      }
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE': {
        const message = data as Message;
        const channelId = message.channelId;
        if (!channelId) return;
        set((state) => ({
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: upsertMessage(
              state.messagesByChannel[channelId] ?? [],
              message,
            ),
          },
        }));
        return;
      }
      case 'MESSAGE_DELETE': {
        const deletion = data as { id: string; channelId: string };
        set((state) => ({
          messagesByChannel: {
            ...state.messagesByChannel,
            [deletion.channelId]: (state.messagesByChannel[deletion.channelId] ?? []).filter(
              (message) => message.id !== deletion.id,
            ),
          },
        }));
        return;
      }
      default:
        return;
    }
  },

  reset: () => {
    gatewayClient?.close();
    gatewayClient = null;
    set({
      gatewayStatus: 'idle',
      activeServerId: null,
      activeChannelId: null,
      serversById: {},
      channelsByServer: {},
      messagesByChannel: {},
      loadingServers: false,
      loadingChannelsByServer: {},
      loadingMessagesByChannel: {},
      error: null,
    });
  },
}));

function serverFromReady(server: ReadyPayload['servers'][number]): Server {
  return {
    id: server.id,
    ownerUserId: server.ownerUserId,
    name: server.name,
    description: null,
    iconAttachmentId: server.iconAttachmentId,
    iconUrl: null,
    defaultRoleId: server.defaultRoleId ?? '',
    federationEnabled: server.federationEnabled ?? false,
    originInstanceId: server.originInstanceId ?? null,
    originInstanceHost: server.originInstanceHost ?? null,
    systemChannelId: null,
    verificationLevel: 'none',
    verificationMinAccountAgeHours: 0,
    createdAt: new Date().toISOString(),
  };
}

function upsertChannel(channels: Channel[], next: Channel): Channel[] {
  const without = channels.filter((channel) => channel.id !== next.id);
  return [...without, next].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

function upsertMessage(messages: Message[], next: Message): Message[] {
  const without = messages.filter((message) => message.id !== next.id);
  return [...without, next].sort((a, b) => a.id.localeCompare(b.id));
}

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}
