import {
  attachmentReadyPayloadSchema,
  presenceUpdatePayloadSchema,
  voiceStateGatewayPayloadSchema,
  type Channel,
  type DmChannel,
  type GatewayDispatchEventName,
  type Message,
  type Server,
  type UserProfile,
} from '@tavern/shared';
import { useAuth } from './auth.js';
import { useRealtime } from './store.js';
import { useInbox, type InboxItem } from './inbox-store.js';
import { GatewayClient } from './gateway-client.js';
import { resolveTerminal } from './attachment-ready.js';
import { maybePlayMessageSound } from './message-sound.js';
import { startPresenceTracking } from './presence.js';
import {
  emitBreakoutClose,
  emitBreakoutOpen,
  emitRecordingConsentRequest,
  emitRecordingConsentUpdate,
  emitRecordingStarted,
  emitRecordingStopped,
  emitWhiteboardClear,
  emitWhiteboardStroke,
  type BreakoutClosePayload,
  type BreakoutOpenPayload,
  type RecordingConsentRequestPayload,
  type RecordingConsentUpdatePayload,
  type RecordingStartedPayload,
  type RecordingStoppedPayload,
  type WhiteboardClearPayload,
  type WhiteboardStrokePayload,
} from './voice-events.js';

let client: GatewayClient | null = null;
let stopPresence: (() => void) | null = null;

interface ReadyPayload {
  user: { id: string };
  /**
   * READY-shaped server: a subset of the full `Server` DTO. Only the columns
   * the client needs to bootstrap the sidebar — there's no description /
   * createdAt because READY is not the canonical CRUD response.
   * `federationEnabled` is optional for forwards-compatibility with API
   * builds that predate P3-10. `originInstanceId` + `originInstanceHost`
   * are similarly optional for P4-16 forwards-compat.
   */
  servers: Array<{
    id: string;
    name: string;
    ownerUserId: string;
    iconAttachmentId: string | null;
    defaultRoleId: string | null;
    federationEnabled?: boolean;
    originInstanceId?: string | null;
    originInstanceHost?: string | null;
    roles: string[];
  }>;
}

export function startRealtime(): GatewayClient {
  if (client) return client;
  const store = useRealtime.getState();
  client = new GatewayClient({
    onStatusChange: (s) => store.setReady(s === 'ready'),
    onDispatch: (event, data) => handleDispatch(event, data),
  });
  client.connect();
  // Wire up the idle timer + initial active heartbeat. Cleaned on stopRealtime.
  if (!stopPresence) stopPresence = startPresenceTracking();
  // Hydrate the unread state / mention count so the bell can render the badge
  // before the user opens it.
  void useInbox.getState().hydrateReadStates();
  return client;
}

export function stopRealtime(): void {
  client?.close();
  client = null;
  stopPresence?.();
  stopPresence = null;
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
          // READY currently sends a partial Server; default any missing flag
          // to false so the wire shape is forwards-compatible with older
          // backends that haven't been redeployed yet.
          federationEnabled: s.federationEnabled ?? false,
          // P4-16 — mirror provenance fields. Default to null when missing
          // (forwards-compat with pre-P4-16 API builds). Once the backend
          // populates these on every READY (see gateway READY emission) the
          // ?? null becomes a no-op.
          originInstanceId: s.originInstanceId ?? null,
          originInstanceHost: s.originInstanceHost ?? null,
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
    case 'MESSAGE_CREATE': {
      const msg = data as Message;
      store.upsertMessage(msg);
      maybePlayMessageSound(msg);
      return;
    }
    case 'MESSAGE_UPDATE':
      store.upsertMessage(data as Message);
      return;
    case 'MESSAGE_DELETE': {
      const d = data as { id: string; channelId: string };
      store.removeMessage(d.channelId, d.id);
      return;
    }
    case 'REACTION_ADD':
    case 'REACTION_REMOVE': {
      const d = data as { messageId: string; userId: string; emoji: string };
      const viewerId = useAuth.getState().me?.id ?? null;
      store.applyReaction(event === 'REACTION_ADD' ? 'add' : 'remove', d, viewerId);
      return;
    }
    case 'SERVER_UPDATE':
      store.upsertServer(data as Server);
      return;
    case 'SERVER_ADD':
      // Phase 4: federated invite acceptance. The API broadcasts SERVER_ADD
      // to the joiner only, so the sidebar can splice the new mirror Server
      // in without a full READY refresh. upsertServer is idempotent — a
      // duplicate event is a no-op.
      store.upsertServer(data as Server);
      return;
    case 'SERVER_REMOVE': {
      // P4-16 — federated mirror leave. The API broadcasts SERVER_REMOVE to
      // the leaver when their tear-down empties the mirror. We splice the
      // Server row + its cached channel list out of the store; the leaver's
      // sidebar updates on the next render. Routes that depend on the row
      // (settings, channel pages) are responsible for handling the
      // navigation away — usually triggered by the same UI action that
      // initiated the leave.
      const d = data as { serverId: string };
      store.removeServer(d.serverId);
      return;
    }
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
    case 'PRESENCE_UPDATE': {
      const parsed = presenceUpdatePayloadSchema.safeParse(data);
      if (!parsed.success) return;
      store.setPresence(parsed.data.userId, parsed.data.presence);
      // PF-2 / follow-up #32: the broadcast OPTIONALLY carries the user's
      // live customStatus. "Absent" and "null" mean different things on the
      // wire — `null` is an explicit clear, missing means "this broadcast
      // didn't touch customStatus". The Zod schema strips unknown keys but
      // preserves the absent-vs-null distinction on declared optional+nullable
      // fields, so `'customStatus' in parsed.data` is the right gate. Without
      // this guard, idle/active flaps (which don't include customStatus)
      // would clobber a previously-set status to undefined on every flap.
      if (
        typeof data === 'object' &&
        data !== null &&
        'customStatus' in (data as Record<string, unknown>)
      ) {
        const expiresAtIso = parsed.data.customStatusExpiresAt ?? null;
        store.setCustomStatus(
          parsed.data.userId,
          parsed.data.customStatus ?? null,
          expiresAtIso === null ? null : new Date(expiresAtIso),
        );
      }
      return;
    }
    case 'MEMBER_UPDATE': {
      // MEMBER_UPDATE is loose on the wire — it may carry nickname-only
      // payloads (from PATCH /servers/:id/members/:userId) or a `user`
      // overlay (from PATCH /users/me/profile), or both. Propagate whatever
      // is present so neither the sidebar nor open profile cards go stale.
      const d = data as {
        serverId?: string;
        userId?: string;
        nickname?: string | null;
        user?: Partial<UserProfile>;
      };
      if (!d.userId) return;
      if (d.user) {
        store.mergeProfileOverlay(d.userId, d.user);
      }
      if (d.serverId && Object.prototype.hasOwnProperty.call(d, 'nickname')) {
        store.setMemberNickname(d.serverId, d.userId, d.nickname ?? null);
      }
      return;
    }
    case 'DM_CHANNEL_CREATE':
    case 'DM_CHANNEL_UPDATE':
      store.upsertDmChannel(data as DmChannel);
      return;
    case 'DM_MESSAGE_CREATE': {
      const msg = data as Message;
      store.upsertDmMessage(msg);
      // Bump the DM channel's lastMessageAt locally so the list re-sorts
      // without waiting for a fresh GET.
      const ch = useRealtime.getState().dmChannelsById[msg.dmChannelId ?? ''];
      if (ch) {
        store.upsertDmChannel({ ...ch, lastMessageAt: msg.createdAt });
      }
      maybePlayMessageSound(msg);
      return;
    }
    case 'DM_MESSAGE_UPDATE':
      store.upsertDmMessage(data as Message);
      return;
    case 'DM_MESSAGE_DELETE': {
      const d = data as { id: string; dmChannelId: string };
      store.removeDmMessage(d.dmChannelId, d.id);
      return;
    }
    case 'MESSAGE_ACK': {
      const d = data as {
        channelId: string;
        lastReadMessageId: string | null;
        lastReadAt: string;
      };
      useInbox.getState().applyAck({
        channelId: d.channelId,
        lastReadMessageId: d.lastReadMessageId,
        lastReadAt: d.lastReadAt,
        mentionCount: 0,
      });
      return;
    }
    case 'MENTION_CREATE': {
      useInbox.getState().onMentionCreate(data as InboxItem);
      return;
    }
    case 'LINK_PREVIEW_READY': {
      const d = data as {
        messageId: string;
        previews: Array<{
          id: string;
          messageId: string;
          url: string;
          title: string | null;
          description: string | null;
          imageUrl: string | null;
          siteName: string | null;
          fetchedAt: string;
        }>;
      };
      store.setLinkPreviews(d.messageId, d.previews);
      return;
    }
    case 'SOUNDBOARD_CUE': {
      // Wave 2 #13 — fire-and-forget local audio playback. The cue carries
      // an attachmentId; we resolve it to a signed URL via /attachments/:id
      // and play it via a plain <Audio> tag attached to the document. The
      // browser's audio output mixes naturally with the LiveKit stream.
      const d = data as { clipId?: string; attachmentId: string; loop?: boolean };
      void playSoundboardClip(d.clipId ?? null, d.attachmentId, !!d.loop);
      return;
    }
    case 'SOUNDBOARD_STOP': {
      // Wave 3 #19 — stop a previously-cued ambient loop by clipId.
      const d = data as { clipId: string };
      stopSoundboardClip(d.clipId);
      return;
    }
    case 'CAPTION_TEXT': {
      // Wave 3 #33 — append a caption line to the per-channel rolling overlay.
      const d = data as {
        channelId: string;
        userId: string;
        displayName: string;
        text: string;
        isFinal: boolean;
        at: number;
      };
      void import('./captions-store.js').then((m) =>
        m.useCaptions.getState().appendLine(d.channelId, {
          userId: d.userId,
          displayName: d.displayName,
          text: d.text,
          isFinal: d.isFinal,
          at: d.at,
        }),
      );
      return;
    }
    case 'BREAKOUT_OPEN': {
      // Wave 3 #29 — host opened breakouts. VoiceRoom subscribes via the
      // voice-events bus and reconnects the LiveKit Room to the user's
      // assigned breakout (if any).
      emitBreakoutOpen(data as BreakoutOpenPayload);
      return;
    }
    case 'BREAKOUT_CLOSE': {
      emitBreakoutClose(data as BreakoutClosePayload);
      return;
    }
    case 'RECORDING_CONSENT_REQUEST': {
      // Wave 3 #32 — host proposed recording; every participant's consent
      // dialog opens via the bus.
      emitRecordingConsentRequest(data as RecordingConsentRequestPayload);
      return;
    }
    case 'RECORDING_CONSENT_UPDATE': {
      emitRecordingConsentUpdate(data as RecordingConsentUpdatePayload);
      return;
    }
    case 'RECORDING_STARTED': {
      emitRecordingStarted(data as RecordingStartedPayload);
      return;
    }
    case 'RECORDING_STOPPED': {
      emitRecordingStopped(data as RecordingStoppedPayload);
      return;
    }
    case 'WHITEBOARD_STROKE': {
      // Wave 3 #34 — remote stroke landed; mounted whiteboards append it.
      emitWhiteboardStroke(data as WhiteboardStrokePayload);
      return;
    }
    case 'WHITEBOARD_CLEAR': {
      emitWhiteboardClear(data as WhiteboardClearPayload);
      return;
    }
    default:
      return;
  }
}

/**
 * Active looping audio elements keyed by clipId, so SOUNDBOARD_STOP can
 * find and pause them. One-shot cues don't register here; they just play
 * out and get GC'd.
 */
const activeLoops: Map<string, HTMLAudioElement> = new Map();

async function playSoundboardClip(
  clipId: string | null,
  attachmentId: string,
  loop: boolean,
): Promise<void> {
  try {
    const att = await (await import('./api-client.js')).api<{ url: string | null }>(
      `/attachments/${attachmentId}`,
    );
    if (!att.url) return;
    // If this clipId is already looping locally, stop the old one before
    // starting again — keeps "play" idempotent and means a re-cue doesn't
    // produce two overlapping tracks.
    if (clipId && activeLoops.has(clipId)) {
      const existing = activeLoops.get(clipId);
      existing?.pause();
      activeLoops.delete(clipId);
    }
    const audio = new Audio(att.url);
    audio.loop = loop;
    audio.volume = 0.8;
    if (loop && clipId) {
      activeLoops.set(clipId, audio);
      audio.addEventListener('ended', () => {
        // Belt-and-suspenders; `loop=true` shouldn't ever fire 'ended', but
        // some browsers do for very short tracks.
        activeLoops.delete(clipId);
      });
    }
    await audio.play();
  } catch {
    // Browsers block autoplay without a gesture; the user just won't hear
    // it. Cues that arrive while focused do play correctly.
  }
}

function stopSoundboardClip(clipId: string): void {
  const audio = activeLoops.get(clipId);
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  activeLoops.delete(clipId);
}
