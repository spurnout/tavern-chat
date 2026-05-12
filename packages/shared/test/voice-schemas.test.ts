import { describe, expect, it } from 'vitest';
import {
  voiceJoinResponseSchema,
  voiceStateGatewayPayloadSchema,
  voiceStateUpdateRequestSchema,
} from '../src/schemas/voice.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';

describe('voiceJoinResponseSchema', () => {
  it('round-trips a well-formed response including expiresAt', () => {
    const payload = {
      liveKitUrl: 'wss://livekit.example.com',
      token: 'jwt-token-string',
      roomName: `server:${ULID}:voice:${ULID}`,
      identity: ULID,
      allowedFeatures: {
        canPublishAudio: true,
        canPublishVideo: true,
        canPublishScreenShare: true,
        canSubscribe: true,
      },
      expiresAt: new Date().toISOString(),
    };
    expect(() => voiceJoinResponseSchema.parse(payload)).not.toThrow();
  });

  it('rejects a response missing expiresAt', () => {
    const payload = {
      liveKitUrl: 'wss://livekit.example.com',
      token: 'jwt',
      roomName: 'r',
      identity: ULID,
      allowedFeatures: {
        canPublishAudio: true,
        canPublishVideo: false,
        canPublishScreenShare: true,
        canSubscribe: true,
      },
    };
    expect(() => voiceJoinResponseSchema.parse(payload)).toThrow();
  });
});

describe('voiceStateUpdateRequestSchema', () => {
  it('accepts a single-field partial update', () => {
    expect(() =>
      voiceStateUpdateRequestSchema.parse({ channelId: ULID, screenSharing: true }),
    ).not.toThrow();
  });

  it('accepts multiple optional fields together', () => {
    expect(() =>
      voiceStateUpdateRequestSchema.parse({
        channelId: ULID,
        screenSharing: false,
        cameraOn: true,
        selfMute: true,
        selfDeaf: false,
      }),
    ).not.toThrow();
  });

  it('requires channelId', () => {
    expect(() => voiceStateUpdateRequestSchema.parse({ screenSharing: true })).toThrow();
  });
});

describe('voiceStateGatewayPayloadSchema', () => {
  it('accepts a full state with channelId present', () => {
    const payload = {
      serverId: ULID,
      userId: ULID,
      channelId: ULID,
      selfMute: false,
      selfDeaf: false,
      cameraOn: true,
      screenSharing: true,
      joinedAt: new Date().toISOString(),
    };
    expect(() => voiceStateGatewayPayloadSchema.parse(payload)).not.toThrow();
  });

  it('accepts a leave payload with channelId/joinedAt nulled', () => {
    const payload = {
      serverId: ULID,
      userId: ULID,
      channelId: null,
      selfMute: false,
      selfDeaf: false,
      cameraOn: false,
      screenSharing: false,
      joinedAt: null,
    };
    expect(() => voiceStateGatewayPayloadSchema.parse(payload)).not.toThrow();
  });

  it('rejects an unknown screenSharing type', () => {
    const payload = {
      serverId: ULID,
      userId: ULID,
      channelId: ULID,
      selfMute: false,
      selfDeaf: false,
      cameraOn: false,
      screenSharing: 'yes',
      joinedAt: null,
    };
    expect(() => voiceStateGatewayPayloadSchema.parse(payload)).toThrow();
  });
});
