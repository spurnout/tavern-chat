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

export type VoiceJoinRequest = z.infer<typeof voiceJoinRequestSchema>;
export type VoiceJoinResponse = z.infer<typeof voiceJoinResponseSchema>;
export type VoiceState = z.infer<typeof voiceStateSchema>;
