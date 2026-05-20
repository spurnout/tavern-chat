import { z } from 'zod';

/**
 * Gateway opcodes — Discord-inspired numeric envelope.
 *
 *  0  DISPATCH       (server -> client)  realtime event
 *  1  HEARTBEAT      (client -> server)  keep-alive
 *  2  IDENTIFY       (client -> server)  authenticate the socket
 *  3  RESUME         (client -> server)  attempt resume after disconnect
 *  6  RECONNECT      (server -> client)  client should reconnect
 *  9  INVALID_SESSION(server -> client)  session is dead — re-IDENTIFY
 * 10  HELLO          (server -> client)  initial greeting; carries heartbeatIntervalMs
 * 11  HEARTBEAT_ACK  (server -> client)
 */
export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 3,
  RECONNECT: 6,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const gatewayHelloPayloadSchema = z.object({
  heartbeatIntervalMs: z.number().int().positive(),
  sessionId: z.string(),
});

export const gatewayIdentifyPayloadSchema = z.object({
  token: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
});

export const gatewayResumePayloadSchema = z.object({
  token: z.string().min(1),
  sessionId: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
});

export const gatewayHeartbeatPayloadSchema = z.object({
  seq: z.number().int().nonnegative().nullable(),
});

export const gatewayPayloadSchema = z.object({
  op: z.number().int().nonnegative(),
  d: z.unknown(),
  s: z.number().int().nonnegative().nullable().optional(),
  t: z.string().nullable().optional(),
});

export const GatewayDispatchEvent = {
  READY: 'READY',
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  MESSAGE_UPDATE: 'MESSAGE_UPDATE',
  MESSAGE_DELETE: 'MESSAGE_DELETE',
  REACTION_ADD: 'REACTION_ADD',
  REACTION_REMOVE: 'REACTION_REMOVE',
  CHANNEL_CREATE: 'CHANNEL_CREATE',
  CHANNEL_UPDATE: 'CHANNEL_UPDATE',
  CHANNEL_DELETE: 'CHANNEL_DELETE',
  SERVER_UPDATE: 'SERVER_UPDATE',
  /**
   * Federation Phase 4 — user-targeted event fired when a Tavern is mirrored
   * onto this instance and the user is added to it as a member (typically the
   * joiner of a federated invite). Delivered ONLY to `userId` so the joiner's
   * SPA can splice the new mirror Server into the sidebar without a full
   * READY refresh. Mirrors are visible only to their members, so a server-
   * scoped broadcast would be wasted fan-out.
   */
  SERVER_ADD: 'SERVER_ADD',
  /**
   * Federation Phase 4 — user-targeted complement of `SERVER_ADD`. Fired
   * when a user voluntarily leaves a federated mirror AND the mirror is
   * torn down because no other local members remain. The recipient
   * `userId` is the leaver; their SPA should splice the Server out of the
   * sidebar. Delivered ONLY to that user — the mirror is gone and there
   * is no server-scoped audience left to broadcast to.
   */
  SERVER_REMOVE: 'SERVER_REMOVE',
  MEMBER_ADD: 'MEMBER_ADD',
  MEMBER_REMOVE: 'MEMBER_REMOVE',
  MEMBER_UPDATE: 'MEMBER_UPDATE',
  ROLE_CREATE: 'ROLE_CREATE',
  ROLE_UPDATE: 'ROLE_UPDATE',
  ROLE_DELETE: 'ROLE_DELETE',
  VOICE_STATE_UPDATE: 'VOICE_STATE_UPDATE',
  TYPING_START: 'TYPING_START',
  PRESENCE_UPDATE: 'PRESENCE_UPDATE',
  EMOJI_CREATE: 'EMOJI_CREATE',
  EMOJI_DELETE: 'EMOJI_DELETE',
  INVITE_CREATE: 'INVITE_CREATE',
  DICE_ROLL_CREATE: 'DICE_ROLL_CREATE',
  CAMPAIGN_CREATE: 'CAMPAIGN_CREATE',
  CAMPAIGN_UPDATE: 'CAMPAIGN_UPDATE',
  CAMPAIGN_SESSION_CREATE: 'CAMPAIGN_SESSION_CREATE',
  CAMPAIGN_SESSION_UPDATE: 'CAMPAIGN_SESSION_UPDATE',
  GAME_NIGHT_CREATE: 'GAME_NIGHT_CREATE',
  GAME_NIGHT_UPDATE: 'GAME_NIGHT_UPDATE',
  MODERATION_EVENT_CREATE: 'MODERATION_EVENT_CREATE',
  /**
   * PERM-002 — emitted to the banned user (and audit-log viewers) on a fresh
   * ban. When the banned user's gateway client receives this, the server
   * closes their socket so any open WebSocket session is severed immediately.
   */
  GUILD_BAN_ADD: 'GUILD_BAN_ADD',
  GUILD_BAN_REMOVE: 'GUILD_BAN_REMOVE',

  /**
   * FE-17 — emitted to the uploader when their attachment finishes the
   * worker pipeline (scan + image normalisation) and flips to status='ready'.
   * Lets the SPA replace `setTimeout(800)` polls with a deterministic event
   * for flows that need the attachment fully processed before they continue
   * (emoji upload, voice-message playback, etc.).
   */
  ATTACHMENT_READY: 'ATTACHMENT_READY',

  /**
   * Phase 6 — direct messages. Server messages reuse the existing
   * MESSAGE_* events because they're routed by channelId; DM messages
   * carry a `dmChannelId` instead and need their own opcodes so the
   * client knows which slice of state to update.
   */
  DM_CHANNEL_CREATE: 'DM_CHANNEL_CREATE',
  DM_CHANNEL_UPDATE: 'DM_CHANNEL_UPDATE',
  DM_MESSAGE_CREATE: 'DM_MESSAGE_CREATE',
  DM_MESSAGE_UPDATE: 'DM_MESSAGE_UPDATE',
  DM_MESSAGE_DELETE: 'DM_MESSAGE_DELETE',

  /**
   * Phase 1.3 — activity inbox / unread state. MESSAGE_ACK is sent only
   * to the user's own sockets so multiple tabs stay in sync after a
   * read-cursor advance. MENTION_CREATE delivers a new mention to the
   * recipient (also user-scoped).
   */
  MESSAGE_ACK: 'MESSAGE_ACK',
  MENTION_CREATE: 'MENTION_CREATE',

  /**
   * Phase 2.1 — message pinning.
   */
  MESSAGE_PIN: 'MESSAGE_PIN',
  MESSAGE_UNPIN: 'MESSAGE_UNPIN',

  /**
   * Phase 3.1 — threads.
   */
  THREAD_CREATE: 'THREAD_CREATE',
  THREAD_UPDATE: 'THREAD_UPDATE',
  THREAD_ARCHIVE: 'THREAD_ARCHIVE',

  /**
   * Phase 3.2 — polls. Tally changes broadcast as POLL_UPDATE; closure
   * is a separate POLL_CLOSE so the client can play a different cue.
   */
  POLL_UPDATE: 'POLL_UPDATE',
  POLL_CLOSE: 'POLL_CLOSE',

  /**
   * Phase 4 — initiative encounters. One event for create/update/end;
   * the round and turn index live on the payload.
   */
  ENCOUNTER_CREATE: 'ENCOUNTER_CREATE',
  ENCOUNTER_UPDATE: 'ENCOUNTER_UPDATE',
  ENCOUNTER_END: 'ENCOUNTER_END',

  /**
   * Wave 2 — chat / TTRPG / account-self-service events.
   */
  LINK_PREVIEW_READY: 'LINK_PREVIEW_READY',
  MEMBER_TIMEOUT: 'MEMBER_TIMEOUT',
  CHARACTER_UPDATE: 'CHARACTER_UPDATE',
  SOUNDBOARD_CUE: 'SOUNDBOARD_CUE',
  /** Wave 3 #19 — stop a previously-cued ambient loop, matched by clipId. */
  SOUNDBOARD_STOP: 'SOUNDBOARD_STOP',
  EXPORT_READY: 'EXPORT_READY',
  /** Wave 3 #40 — bulk import dropped N messages into a channel. */
  CHANNEL_IMPORT: 'CHANNEL_IMPORT',
  /** Wave 3 #26 — a watch party started in a voice room. */
  WATCH_PARTY_START: 'WATCH_PARTY_START',
  /** Wave 3 #26 — host pushed a play/pause/seek for the running party. */
  WATCH_PARTY_STATE: 'WATCH_PARTY_STATE',
  /** Wave 3 #26 — host (or a mod) ended the party. */
  WATCH_PARTY_END: 'WATCH_PARTY_END',
  /** Wave 3 #33 — a speaker's live caption line. */
  CAPTION_TEXT: 'CAPTION_TEXT',
  /** Wave 3 #29 — breakout rooms opened off a parent voice channel. */
  BREAKOUT_OPEN: 'BREAKOUT_OPEN',
  /** Wave 3 #29 — breakouts closed; everyone returns to the parent. */
  BREAKOUT_CLOSE: 'BREAKOUT_CLOSE',
  /** Wave 3 #32 — host proposed a recording; participants must consent. */
  RECORDING_CONSENT_REQUEST: 'RECORDING_CONSENT_REQUEST',
  /** Wave 3 #32 — a participant updated their consent state. */
  RECORDING_CONSENT_UPDATE: 'RECORDING_CONSENT_UPDATE',
  /** Wave 3 #32 — all consented; recording is live. */
  RECORDING_STARTED: 'RECORDING_STARTED',
  /** Wave 3 #32 — recording stopped. */
  RECORDING_STOPPED: 'RECORDING_STOPPED',
  /** Wave 3 #34 — a stroke was added to a channel's whiteboard. */
  WHITEBOARD_STROKE: 'WHITEBOARD_STROKE',
  /** Wave 3 #34 — the whiteboard was cleared. */
  WHITEBOARD_CLEAR: 'WHITEBOARD_CLEAR',
} as const;

export const attachmentReadyPayloadSchema = z.object({
  attachmentId: z.string().min(1),
  /** Final attachment status — usually 'ready', but may be 'failed' / 'blocked' / 'quarantined'. */
  status: z.string().min(1),
});

export type AttachmentReadyPayload = z.infer<typeof attachmentReadyPayloadSchema>;

export type GatewayDispatchEventName =
  (typeof GatewayDispatchEvent)[keyof typeof GatewayDispatchEvent];

export type GatewayPayload<T = unknown> = {
  op: number;
  d: T;
  s?: number | null;
  t?: GatewayDispatchEventName | null;
};

export type GatewayHelloPayload = z.infer<typeof gatewayHelloPayloadSchema>;
export type GatewayIdentifyPayload = z.infer<typeof gatewayIdentifyPayloadSchema>;
export type GatewayResumePayload = z.infer<typeof gatewayResumePayloadSchema>;
export type GatewayHeartbeatPayload = z.infer<typeof gatewayHeartbeatPayloadSchema>;
