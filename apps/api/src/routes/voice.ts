import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
  stagePosition?: 'audience' | 'speaker' | null;
  handRaisedAt?: Date | null;
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
    stagePosition: row.stagePosition ?? null,
    handRaisedAt: row.handRaisedAt?.toISOString() ?? null,
  });
}

export async function registerVoiceRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  app.post('/api/voice/join', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = voiceJoinRequestSchema.parse(req.body);

    const channel = await prisma.channel.findUnique({
      where: { id: body.channelId },
      select: { id: true, type: true, serverId: true, videoEnabled: true },
    });
    if (!channel) throw TavernError.notFound('Channel not found');
    if (
      channel.type !== 'voice' &&
      channel.type !== 'session' &&
      channel.type !== 'campaign' &&
      channel.type !== 'stage'
    ) {
      throw new TavernError(ErrorCodes.WRONG_CHANNEL_TYPE, 'Channel is not a voice channel', 400);
    }

    const result = await requireChannelPermission(channel.id, ctx.userId, Permission.CONNECT_VOICE);
    const isAdminOrManager =
      (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR ||
      (result.perms & Permission.MANAGE_CHANNELS) === Permission.MANAGE_CHANNELS;

    // Wave 3 #25 — stage rooms. For 'stage' channels, audience members can
    // join the room but can NOT publish audio. Promotion to speaker is a
    // separate route; the user's existing token has no publish grant until
    // they /voice/refresh-token after being promoted.
    let stagePosition: 'audience' | 'speaker' | null = null;
    if (channel.type === 'stage') {
      const existingState = await prisma.voiceState.findUnique({
        where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
        select: { stagePosition: true },
      });
      // Channel managers default to speaker on first join so the host can
      // actually run the show; everyone else lands as audience.
      stagePosition =
        existingState?.stagePosition ?? (isAdminOrManager ? 'speaker' : 'audience');
    }

    const stageMutesAudio = channel.type === 'stage' && stagePosition !== 'speaker';
    const canPublishAudio =
      !stageMutesAudio &&
      ((result.perms & Permission.SPEAK_VOICE) === Permission.SPEAK_VOICE ||
        (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR);
    const canPublishVideo =
      !stageMutesAudio &&
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
    if (canPublishScreenShare) {
      // VC-012: must grant both video AND audio sub-sources. With `audio: true`
      // in the share options the LiveKit JS SDK publishes two tracks
      // (`screen_share` + `screen_share_audio`); granting only `screen_share`
      // makes the SDK abort the whole publish with "insufficient permissions
      // to publish" on the audio track, leaving the user with a black tile.
      sources.push('screen_share', 'screen_share_audio');
    }

    const { token, expiresAt } = await signLiveKitToken({
      apiKey: liveKitKey,
      apiSecret: liveKitSecret,
      identity: ctx.userId,
      name: me?.displayName ?? me?.username ?? 'Tavern user',
      // 15-minute TTL. The frontend refreshes on a 5-minute lead, so each
      // session ends up rotating tokens every ~10 minutes. A short TTL is
      // the only enforcement we have for "a moderator revoked STREAM_SCREEN
      // mid-session" — LiveKit honors the old grant until the token expires.
      ttlSeconds: 15 * 60,
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
    // 10 minutes is well beyond a normal reconnect window but short enough
    // that a phantom "is sharing" indicator clears within a coffee break.
    const stale = new Date(Date.now() - 10 * 60 * 1000);
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
        stagePosition,
        handRaisedAt: null,
      },
      update: {
        channelId: channel.id,
        joinedAt: now,
        selfMute: false,
        selfDeaf: false,
        cameraOn: false,
        screenSharing: false,
        stagePosition,
        // Joining a stage clears any prior raised-hand flag.
        handRaisedAt: null,
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

  // VC-001: LiveKit token TTL is 15 minutes (see `/voice/join`). The client
  // requests a fresh token a few minutes before expiry so a long voice
  // session doesn't get disconnected. Re-checks permissions against live
  // state, so a role demote since `/join` narrows what the new token can
  // publish at the next rotation.
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
      if (
        channel.type !== 'voice' &&
        channel.type !== 'session' &&
        channel.type !== 'campaign' &&
        channel.type !== 'stage'
      ) {
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
      // Wave 3 #25 — stage rooms reapply the audience mute on every refresh
      // so a promotion (or demotion) is honoured immediately at the next
      // 5-minute rotation, without the user needing to fully rejoin.
      const stageMuted = channel.type === 'stage' && existing.stagePosition !== 'speaker';
      const canAudio =
        !stageMuted &&
        ((perms.perms & Permission.SPEAK_VOICE) === Permission.SPEAK_VOICE ||
          (perms.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR);
      const canVideo =
        !stageMuted &&
        channel.videoEnabled &&
        ((perms.perms & Permission.ENABLE_CAMERA) === Permission.ENABLE_CAMERA ||
          (perms.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR);
      const canScreen =
        (perms.perms & Permission.STREAM_SCREEN) === Permission.STREAM_SCREEN ||
        (perms.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
      const refreshSources: string[] = [];
      if (canAudio) refreshSources.push('microphone');
      if (canVideo) refreshSources.push('camera');
      // VC-012: grant both screen video and audio sub-sources (see /voice/join).
      if (canScreen) refreshSources.push('screen_share', 'screen_share_audio');
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true, username: true },
      });
      const refreshed = await signLiveKitToken({
        apiKey: cfg.LIVEKIT_API_KEY,
        apiSecret: cfg.LIVEKIT_API_SECRET,
        identity: ctx.userId,
        name: me?.displayName ?? me?.username ?? 'Tavern user',
        ttlSeconds: 15 * 60,
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

      // Build the gateway payloads directly from the pre-update snapshot
      // plus the known cleared fields — every value the post-update payload
      // needs is either on `states` (serverId, userId) or fixed by the
      // updateMany above (channelId=null, joinedAt=null, all flags=false).
      // Skipping the re-read keeps this hot path single-query.
      for (const s of states) {
        const previousChannelId = s.channelId;
        gatewayBroker.publish({
          type: 'VOICE_STATE_UPDATE',
          serverId: s.serverId,
          ...(previousChannelId ? { channelId: previousChannelId } : {}),
          data: voiceStatePayload({
            serverId: s.serverId,
            userId: ctx.userId,
            channelId: null,
            selfMute: false,
            selfDeaf: false,
            cameraOn: false,
            screenSharing: false,
            joinedAt: null,
          }),
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
    if (
      channel.type !== 'voice' &&
      channel.type !== 'session' &&
      channel.type !== 'campaign' &&
      channel.type !== 'stage'
    ) {
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

  // -------------------------------------------------------------------------
  // Wave 3 #25 — stage-room hand-raising + speaker promotion.
  //
  // Raise-hand is a soft signal: the audience member's tile gets a flag the
  // host can act on. Promotion flips their `stagePosition` to `speaker`; the
  // user's next /voice/refresh-token (auto-fired every 5 minutes by the
  // client) will then come back with `canPublishAudio: true` and they can
  // unmute themselves. Demotion is the inverse.
  // -------------------------------------------------------------------------

  async function loadStageChannel(channelId: string): Promise<{
    id: string;
    serverId: string;
  }> {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, type: true, serverId: true },
    });
    if (!channel) throw TavernError.notFound('Channel not found');
    if (channel.type !== 'stage') {
      throw new TavernError(
        ErrorCodes.WRONG_CHANNEL_TYPE,
        'This action only applies to stage rooms',
        400,
      );
    }
    return { id: channel.id, serverId: channel.serverId };
  }

  app.post('/api/voice/:channelId/raise-hand', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z
        .object({ channelId: z.string().min(1).max(40) })
        .parse(req.params);
      const channel = await loadStageChannel(channelId);
      // Caller must already be in the channel as audience.
      const state = await prisma.voiceState.findUnique({
        where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
      });
      if (!state || state.channelId !== channel.id || state.stagePosition === 'speaker') {
        throw TavernError.validation('You are not an audience member in this stage');
      }
      const updated = await prisma.voiceState.update({
        where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
        data: { handRaisedAt: new Date() },
      });
      gatewayBroker.publish({
        type: 'VOICE_STATE_UPDATE',
        serverId: channel.serverId,
        channelId: channel.id,
        data: voiceStatePayload(updated),
      });
      reply.send(ok({ ok: true }));
    },
  });

  app.post('/api/voice/:channelId/lower-hand', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z
      .object({ channelId: z.string().min(1).max(40) })
      .parse(req.params);
    const channel = await loadStageChannel(channelId);
    const state = await prisma.voiceState.findUnique({
      where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
    });
    if (!state || state.channelId !== channel.id) {
      reply.send(ok({ ok: true }));
      return;
    }
    const updated = await prisma.voiceState.update({
      where: { serverId_userId: { serverId: channel.serverId, userId: ctx.userId } },
      data: { handRaisedAt: null },
    });
    gatewayBroker.publish({
      type: 'VOICE_STATE_UPDATE',
      serverId: channel.serverId,
      channelId: channel.id,
      data: voiceStatePayload(updated),
    });
    reply.send(ok({ ok: true }));
  });

  app.post('/api/voice/:channelId/promote/:userId', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId, userId } = z
        .object({ channelId: z.string().min(1).max(40), userId: z.string().min(1).max(40) })
        .parse(req.params);
      const channel = await loadStageChannel(channelId);
      // Host gate — MANAGE_CHANNELS is the closest "stage moderator" perm.
      await requireChannelPermission(channel.id, ctx.userId, Permission.MANAGE_CHANNELS);
      const target = await prisma.voiceState.findUnique({
        where: { serverId_userId: { serverId: channel.serverId, userId } },
      });
      if (!target || target.channelId !== channel.id) {
        throw TavernError.notFound('Target is not in this stage');
      }
      const updated = await prisma.voiceState.update({
        where: { serverId_userId: { serverId: channel.serverId, userId } },
        data: { stagePosition: 'speaker', handRaisedAt: null },
      });
      gatewayBroker.publish({
        type: 'VOICE_STATE_UPDATE',
        serverId: channel.serverId,
        channelId: channel.id,
        data: voiceStatePayload(updated),
      });
      reply.send(ok({ ok: true }));
    },
  });

  app.post('/api/voice/:channelId/demote/:userId', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId, userId } = z
        .object({ channelId: z.string().min(1).max(40), userId: z.string().min(1).max(40) })
        .parse(req.params);
      const channel = await loadStageChannel(channelId);
      // Self-demotion is allowed even without MANAGE_CHANNELS; otherwise
      // hosts only.
      if (userId !== ctx.userId) {
        await requireChannelPermission(channel.id, ctx.userId, Permission.MANAGE_CHANNELS);
      }
      const target = await prisma.voiceState.findUnique({
        where: { serverId_userId: { serverId: channel.serverId, userId } },
      });
      if (!target || target.channelId !== channel.id) {
        throw TavernError.notFound('Target is not in this stage');
      }
      const updated = await prisma.voiceState.update({
        where: { serverId_userId: { serverId: channel.serverId, userId } },
        data: { stagePosition: 'audience', handRaisedAt: null },
      });
      gatewayBroker.publish({
        type: 'VOICE_STATE_UPDATE',
        serverId: channel.serverId,
        channelId: channel.id,
        data: voiceStatePayload(updated),
      });
      reply.send(ok({ ok: true }));
    },
  });
}
