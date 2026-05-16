import { z } from 'zod';
import { idSchema } from './ids.js';

export const voiceJoinRequestSchema = z.object({
  channelId: idSchema,
});

export const voiceJoinResponseSchema = z.object({
  liveKitUrl: z.string().url(),
  token: z.string(),
  roomName: z.string(),
  identity: z.string(),
  allowedFeatures: z.object({
    canPublishAudio: z.boolean(),
    canPublishVideo: z.boolean(),
    canPublishScreenShare: z.boolean(),
    canSubscribe: z.boolean(),
  }),
  expiresAt: z.string().datetime(),
});

export const voiceStateSchema = z.object({
  serverId: idSchema,
  channelId: idSchema.nullable(),
  userId: idSchema,
  selfMute: z.boolean(),
  selfDeaf: z.boolean(),
  serverMute: z.boolean(),
  serverDeaf: z.boolean(),
  cameraOn: z.boolean(),
  screenSharing: z.boolean(),
  joinedAt: z.string().datetime().nullable(),
});

/**
 * Client → server: partial voice state update.
 *
 * The client sends only the fields that have changed (e.g. `{ screenSharing: true }`).
 * Server applies them to the row keyed by (serverId, userId), then fans out a
 * full {@link voiceStateGatewayPayloadSchema} via the gateway broker.
 */
export const voiceStateUpdateRequestSchema = z.object({
  channelId: idSchema,
  selfMute: z.boolean().optional(),
  selfDeaf: z.boolean().optional(),
  cameraOn: z.boolean().optional(),
  screenSharing: z.boolean().optional(),
});

/**
 * Server → client: fan-out payload for VOICE_STATE_UPDATE dispatch events.
 *
 * `channelId: null` means the user left the channel (all transient flags zeroed).
 */
export const voiceStateGatewayPayloadSchema = z.object({
  serverId: idSchema,
  userId: idSchema,
  channelId: idSchema.nullable(),
  selfMute: z.boolean(),
  selfDeaf: z.boolean(),
  cameraOn: z.boolean(),
  screenSharing: z.boolean(),
  joinedAt: z.string().datetime().nullable(),
  /**
   * Wave 3 #25 — stage rooms. `null` outside `stage` channels.
   * `audience` users can't publish audio; `speaker` users can.
   */
  stagePosition: z.enum(['audience', 'speaker']).nullable().optional(),
  /** Wave 3 #25 — set when an audience member is asking to be promoted. */
  handRaisedAt: z.string().datetime().nullable().optional(),
});

export type VoiceJoinRequest = z.infer<typeof voiceJoinRequestSchema>;
export type VoiceJoinResponse = z.infer<typeof voiceJoinResponseSchema>;
export type VoiceState = z.infer<typeof voiceStateSchema>;
export type VoiceStateUpdateRequest = z.infer<typeof voiceStateUpdateRequestSchema>;
export type VoiceStateGatewayPayload = z.infer<typeof voiceStateGatewayPayloadSchema>;
