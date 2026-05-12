import {
  attachmentReadyPayloadSchema,
  voiceStateGatewayPayloadSchema,
  type Channel,
  type GatewayDispatchEventName,
  type Message,
  type Server,
} from '@tavern/shared';
import { useRealtime } from './store.js';
import { GatewayClient } from './gateway-client.js';
import { resolveTerminal } from './attachment-ready.js';

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
    case 'VOICE_STATE_UPDATE': {
      // A malformed payload should not crash the dispatch loop — drop and skip.
      // Dev gets a console hint; production stays silent.
      const parsed = voiceStateGatewayPayloadSchema.safeParse(data);
      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('VOICE_STATE_UPDATE failed validation', parsed.error.issues);
        }
        return;
      }
      store.applyVoiceState(parsed.data);
      return;
    }
    case 'ATTACHMENT_READY': {
      // FE-17: resolve any awaitTerminal() promise registered for this
      // attachmentId. The bus is single-purpose and short-lived; callers
      // race against their own timeout, so a missed event self-cleans.
      const parsed = attachmentReadyPayloadSchema.safeParse(data);
      if (!parsed.success) return;
      resolveTerminal(parsed.data.attachmentId, parsed.data.status);
      return;
    }
    default:
      return;
  }
}
