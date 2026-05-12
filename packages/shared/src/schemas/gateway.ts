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
} as const;

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
