import type {
  Channel,
  GatewayDispatchEventName,
  Message,
  Server,
} from '@tavern/shared';
import { useRealtime } from './store.js';
import { GatewayClient } from './gateway-client.js';

let client: GatewayClient | null = null;

interface ReadyPayload {
  user: { id: string };
  servers: Array<Server & { roles: string[] }>;
}

export function startRealtime(): GatewayClient {
  if (client) return client;
  const store = useRealtime.getState();
  client = new GatewayClient({
    onStatusChange: (s) => store.setReady(s === 'ready'),
    onDispatch: (event, data) => handleDispatch(event, data),
  });
  client.connect();
  return client;
}

export function stopRealtime(): void {
  client?.close();
  client = null;
  useRealtime.getState().setReady(false);
}

function handleDispatch(event: GatewayDispatchEventName, data: unknown): void {
  const store = useRealtime.getState();
  switch (event) {
    case 'READY': {
      const ready = data as ReadyPayload;
      for (const s of ready.servers) {
        store.upsertServer({
          id: s.id,
          ownerUserId: s.ownerUserId,
          name: s.name,
          description: null,
          iconAttachmentId: s.iconAttachmentId,
          defaultRoleId: s.defaultRoleId ?? '',
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      store.upsertChannel(data as Channel);
      return;
    case 'CHANNEL_DELETE': {
      const d = data as { id: string };
      store.removeChannel(d.id);
      return;
    }
    case 'MESSAGE_CREATE':
    case 'MESSAGE_UPDATE':
      store.upsertMessage(data as Message);
      return;
    case 'MESSAGE_DELETE': {
      const d = data as { id: string; channelId: string };
      store.removeMessage(d.channelId, d.id);
      return;
    }
    case 'SERVER_UPDATE':
      store.upsertServer(data as Server);
      return;
    case 'TYPING_START': {
      const d = data as { channelId: string; userId: string };
      store.noteTyping(d.channelId, d.userId, Date.now());
      return;
    }
    default:
      return;
  }
}
