import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import {
  ErrorCodes,
  Permission,
  TavernError,
  voiceJoinRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { signLiveKitToken } from '../services/livekit-token.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import type { Config } from '../config.js';

export async function registerVoiceRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  app.post('/api/voice/join', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = voiceJoinRequestSchema.parse(req.body);

    const channel = await prisma.channel.findUnique({
      where: { id: body.channelId },
      select: { id: true, type: true, serverId: true, videoEnabled: true },
    });
    if (!channel) throw TavernError.notFound('Channel not found');
    if (channel.type !== 'voice' && channel.type !== 'session' && channel.type !== 'campaign') {
      throw new TavernError(ErrorCodes.WRONG_CHANNEL_TYPE, 'Channel is not a voice channel', 400);
    }

    const result = await requireChannelPermission(channel.id, ctx.userId, Permission.CONNECT_VOICE);
    const canPublishAudio =
      (result.perms & Permission.SPEAK_VOICE) === Permission.SPEAK_VOICE ||
      (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
    const canPublishVideo =
      channel.videoEnabled &&
      ((result.perms & Permission.ENABLE_CAMERA) === Permission.ENABLE_CAMERA ||
        (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR);
    const canPublishScreenShare =
      (result.perms & Permission.STREAM_SCREEN) === Permission.STREAM_SCREEN ||
      (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;

    if (!cfg.LIVEKIT_API_KEY || !cfg.LIVEKIT_API_SECRET) {
      throw new TavernError(ErrorCodes.VOICE_UNAVAILABLE, 'Voice is not configured', 503);
    }

    const me = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { displayName: true, username: true },
    });

    const roomName = `server:${channel.serverId}:voice:${channel.id}`;
    const sources: string[] = [];
    if (canPublishAudio) sources.push('microphone');
    if (canPublishVideo) sources.push('camera');
    if (canPublishScreenShare) sources.push('screen_share');

    const { token, expiresAt } = await signLiveKitToken({
      apiKey: cfg.LIVEKIT_API_KEY,
      apiSecret: cfg.LIVEKIT_API_SECRET,
      identity: ctx.userId,
      name: me?.displayName ?? me?.username ?? 'Tavern user',
      ttlSeconds: 60 * 60,
      grant: {
        roomJoin: true,
        room: roomName,
        canPublish: sources.length > 0,
        canPublishData: true,
        canSubscribe: true,
        canPublishSources: sources,
      },
    });

    // Mirror voice state in DB so the UI shows who's in the channel.
    await prisma.voiceState.upsert({
      where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
      create: {
        serverId: channel.serverId,
        userId: ctx.userId,
        channelId: channel.id,
        joinedAt: new Date(),
      },
      update: {
        channelId: channel.id,
        joinedAt: new Date(),
      },
    });
    gatewayBroker.publish({
      type: 'VOICE_STATE_UPDATE',
      serverId: channel.serverId,
      data: {
        serverId: channel.serverId,
        userId: ctx.userId,
        channelId: channel.id,
        joinedAt: new Date().toISOString(),
      },
    });

    reply.send(
      ok({
        liveKitUrl: cfg.LIVEKIT_URL,
        token,
        roomName,
        identity: ctx.userId,
        allowedFeatures: {
          canPublishAudio,
          canPublishVideo,
          canPublishScreenShare,
          canSubscribe: true,
        },
        expiresAt: expiresAt.toISOString(),
      }),
    );
  });

  app.post('/api/voice/leave', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const states = await prisma.voiceState.findMany({ where: { userId: ctx.userId } });
    for (const s of states) {
      await prisma.voiceState.update({
        where: { serverId_userId: { serverId: s.serverId, userId: ctx.userId } },
        data: { channelId: null, joinedAt: null },
      });
      gatewayBroker.publish({
        type: 'VOICE_STATE_UPDATE',
        serverId: s.serverId,
        data: { serverId: s.serverId, userId: ctx.userId, channelId: null },
      });
    }
    reply.send(ok({ ok: true }));
  });
}
