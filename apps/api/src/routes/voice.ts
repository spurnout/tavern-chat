import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import {
  ErrorCodes,
  Permission,
  TavernError,
  voiceJoinRequestSchema,
  voiceStateUpdateRequestSchema,
  voiceStateGatewayPayloadSchema,
  type VoiceStateGatewayPayload,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { signLiveKitToken } from '../services/livekit-token.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import type { Config } from '../config.js';

/**
 * Build the gateway-broker payload from a {@link import('@tavern/db').VoiceState} row.
 * The schema runs as a self-check so route bugs surface before fan-out.
 */
function voiceStatePayload(row: {
  serverId: string;
  userId: string;
  channelId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  joinedAt: Date | null;
}): VoiceStateGatewayPayload {
  return voiceStateGatewayPayloadSchema.parse({
    serverId: row.serverId,
    userId: row.userId,
    channelId: row.channelId,
    selfMute: row.selfMute,
    selfDeaf: row.selfDeaf,
    cameraOn: row.cameraOn,
    screenSharing: row.screenSharing,
    joinedAt: row.joinedAt?.toISOString() ?? null,
  });
}

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

    if (!cfg.LIVEKIT_URL || !cfg.LIVEKIT_API_KEY || !cfg.LIVEKIT_API_SECRET) {
      throw new TavernError(
        ErrorCodes.VOICE_UNAVAILABLE,
        'Voice is not configured on this instance.',
        503,
      );
    }
    const liveKitUrl = cfg.LIVEKIT_URL;
    const liveKitKey = cfg.LIVEKIT_API_KEY;
    const liveKitSecret = cfg.LIVEKIT_API_SECRET;

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
      apiKey: liveKitKey,
      apiSecret: liveKitSecret,
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

    // Sweep stale `screenSharing` / `cameraOn` flags on this user's rows. If
    // the browser crashed during a previous session, the row can sit at
    // `true` indefinitely — the truth source is LiveKit, which we don't poll.
    // An hour-old `joinedAt` is plenty of slack for a real reconnect.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.voiceState.updateMany({
      where: {
        userId: ctx.userId,
        joinedAt: { lt: stale },
        OR: [{ screenSharing: true }, { cameraOn: true }, { selfMute: true }, { selfDeaf: true }],
      },
      data: { screenSharing: false, cameraOn: false, selfMute: false, selfDeaf: false },
    });

    // Mirror voice state in DB so the UI shows who's in the channel.
    // Both branches reset transient flags — a fresh join starts with mic on,
    // camera off, screen off, regardless of what the previous session left behind.
    const now = new Date();
    const updated = await prisma.voiceState.upsert({
      where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
      create: {
        serverId: channel.serverId,
        userId: ctx.userId,
        channelId: channel.id,
        joinedAt: now,
        selfMute: false,
        selfDeaf: false,
        cameraOn: false,
        screenSharing: false,
      },
      update: {
        channelId: channel.id,
        joinedAt: now,
        selfMute: false,
        selfDeaf: false,
        cameraOn: false,
        screenSharing: false,
      },
    });
    gatewayBroker.publish({
      type: 'VOICE_STATE_UPDATE',
      serverId: channel.serverId,
      // RT-001: include channelId so the gateway's per-recipient permission
      // check evaluates VIEW_CHANNEL on this specific channel rather than
      // falling back to server-level membership. Without this, hidden voice
      // channels leak presence + camera/screen-share state to every server
      // member.
      channelId: channel.id,
      data: voiceStatePayload(updated),
    });

    reply.send(
      ok({
        liveKitUrl,
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

  // VC-001: LiveKit token TTL is 1h. The client requests a fresh token a few
  // minutes before expiry so a long voice session doesn't get disconnected.
  // Re-checks permissions against live state, so a role demote since `/join`
  // narrows what the new token can publish.
  app.post('/api/voice/refresh-token', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
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
      // Must currently be in the channel — refresh is for in-progress
      // sessions, not a back-door join.
      const existing = await prisma.voiceState.findUnique({
        where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
      });
      if (!existing || existing.channelId !== channel.id) {
        throw TavernError.conflict(
          ErrorCodes.VOICE_STATE_STALE,
          'You are not currently in this voice room.',
        );
      }
      const perms = await requireChannelPermission(channel.id, ctx.userId, Permission.CONNECT_VOICE);
      if (!cfg.LIVEKIT_URL || !cfg.LIVEKIT_API_KEY || !cfg.LIVEKIT_API_SECRET) {
        throw new TavernError(ErrorCodes.VOICE_UNAVAILABLE, 'Voice not configured', 503);
      }
      const canAudio =
        (perms.perms & Permission.SPEAK_VOICE) === Permission.SPEAK_VOICE ||
        (perms.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
      const canVideo =
        channel.videoEnabled &&
        ((perms.perms & Permission.ENABLE_CAMERA) === Permission.ENABLE_CAMERA ||
          (perms.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR);
      const canScreen =
        (perms.perms & Permission.STREAM_SCREEN) === Permission.STREAM_SCREEN ||
        (perms.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
      const refreshSources: string[] = [];
      if (canAudio) refreshSources.push('microphone');
      if (canVideo) refreshSources.push('camera');
      if (canScreen) refreshSources.push('screen_share');
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, username: true },
      });
      const refreshed = await signLiveKitToken({
        apiKey: cfg.LIVEKIT_API_KEY,
        apiSecret: cfg.LIVEKIT_API_SECRET,
        identity: ctx.userId,
        name: me?.displayName ?? me?.username ?? 'Tavern user',
        ttlSeconds: 60 * 60,
        grant: {
          roomJoin: true,
          room: `server:${channel.serverId}:voice:${channel.id}`,
          canPublish: refreshSources.length > 0,
          canPublishData: true,
          canSubscribe: true,
          canPublishSources: refreshSources,
        },
      });
      reply.send(
        ok({
          token: refreshed.token,
          expiresAt: refreshed.expiresAt.toISOString(),
          allowedFeatures: {
            canPublishAudio: canAudio,
            canPublishVideo: canVideo,
            canPublishScreenShare: canScreen,
            canSubscribe: true,
          },
        }),
      );
    },
  });

  app.post('/api/voice/leave', {
    // RT-008: cap so a misbehaving client (or stuck reconnect loop) can't
    // hammer this expensive endpoint. The actual leave flow is idempotent.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      // Only states the user is actually in. Snapshot the previousChannelId
      // for each before clearing so the fanout below can use the channel-
      // scoped permission filter (RT-001).
      const states = await prisma.voiceState.findMany({
        where: { userId: ctx.userId, channelId: { not: null } },
      });
      if (states.length === 0) {
        reply.send(ok({ ok: true }));
        return;
      }

      // RT-008: batched updateMany replaces the per-row update loop. One
      // round-trip clears every voice state for this user.
      await prisma.voiceState.updateMany({
        where: { userId: ctx.userId, channelId: { not: null } },
        data: {
          channelId: null,
          joinedAt: null,
          selfMute: false,
          selfDeaf: false,
          cameraOn: false,
          screenSharing: false,
        },
      });

      // Re-read just enough to build the gateway payloads. Without this we'd
      // have to construct the payload from `states` plus the cleared fields,
      // which duplicates the source of truth.
      const updated = await prisma.voiceState.findMany({
        where: {
          OR: states.map((s) => ({
            serverId: s.serverId,
            userId: ctx.userId,
          })),
        },
      });
      const updatedByServer = new Map(updated.map((u) => [u.serverId, u]));

      for (const s of states) {
        const previousChannelId = s.channelId;
        const u = updatedByServer.get(s.serverId);
        if (!u) continue;
        gatewayBroker.publish({
          type: 'VOICE_STATE_UPDATE',
          serverId: s.serverId,
          ...(previousChannelId ? { channelId: previousChannelId } : {}),
          data: voiceStatePayload(u),
        });
      }
      reply.send(ok({ ok: true }));
    },
  });

  app.post('/api/voice/state', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = voiceStateUpdateRequestSchema.parse(req.body);

    const channel = await prisma.channel.findUnique({
      where: { id: body.channelId },
      select: { id: true, type: true, serverId: true, videoEnabled: true },
    });
    if (!channel) throw TavernError.notFound('Channel not found');
    if (channel.type !== 'voice' && channel.type !== 'session' && channel.type !== 'campaign') {
      throw new TavernError(ErrorCodes.WRONG_CHANNEL_TYPE, 'Channel is not a voice channel', 400);
    }

    // The user must currently be in this channel. Catches stale-tab updates
    // after a leave and prevents spoofing a state for a channel you never joined.
    const existing = await prisma.voiceState.findUnique({
      where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
    });
    if (!existing || existing.channelId !== channel.id || existing.joinedAt === null) {
      throw TavernError.conflict(
        ErrorCodes.VOICE_STATE_STALE,
        'You are not currently in this voice room.',
      );
    }

    // Re-check publish permissions on the live perms — token grants are
    // baked at /voice/join and can outlive a role demote by up to the TTL.
    if (body.screenSharing === true) {
      await requireChannelPermission(channel.id, ctx.userId, Permission.STREAM_SCREEN);
    }
    if (body.cameraOn === true) {
      if (!channel.videoEnabled) {
        throw new TavernError(
          ErrorCodes.WRONG_CHANNEL_TYPE,
          'Video is disabled for this room.',
          400,
        );
      }
      await requireChannelPermission(channel.id, ctx.userId, Permission.ENABLE_CAMERA);
    }

    const data: Record<string, boolean> = {};
    if (body.screenSharing !== undefined) data.screenSharing = body.screenSharing;
    if (body.cameraOn !== undefined) data.cameraOn = body.cameraOn;
    if (body.selfMute !== undefined) data.selfMute = body.selfMute;
    if (body.selfDeaf !== undefined) data.selfDeaf = body.selfDeaf;

    const updated = await prisma.voiceState.update({
      where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
      data,
    });
    gatewayBroker.publish({
      type: 'VOICE_STATE_UPDATE',
      serverId: channel.serverId,
      // RT-001: channel-scoped fanout
      channelId: channel.id,
      data: voiceStatePayload(updated),
    });

    reply.send(ok({ ok: true }));
    },
  });
}
