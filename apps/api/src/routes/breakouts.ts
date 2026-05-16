import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { signLiveKitToken } from '../services/livekit-token.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import type { Config } from '../config.js';

const createBodySchema = z.object({
  groups: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        memberIds: z.array(idSchema).min(1).max(50),
      }),
    )
    .min(1)
    .max(20),
  /** Optional duration (minutes). Acts as an advisory auto-merge timer. */
  minutes: z.number().int().min(1).max(180).optional(),
});

/**
 * Wave 3 #29 — breakout rooms.
 *
 * Host creates N child LiveKit rooms parented to a voice channel and
 * assigns members. Each client receives `BREAKOUT_OPEN` with their group's
 * LiveKit room name + a fresh token; the client's VoiceRoom replaces its
 * LiveKit connection with the new room. End-all returns everyone via
 * `BREAKOUT_CLOSE`.
 */
export async function registerBreakoutRoutes(
  app: FastifyInstance,
  cfg: Config,
): Promise<void> {
  app.get('/api/voice/:channelId/breakouts', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);
    const rows = await prisma.breakoutGroup.findMany({
      where: { parentChannelId: channelId, endedAt: null },
      include: { members: { select: { userId: true, joinedAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    reply.send(ok(rows.map(serialize)));
  });

  app.post('/api/voice/:channelId/breakouts', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const body = createBodySchema.parse(req.body);
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_CHANNELS);

      // End any prior breakouts on the same parent before creating new
      // ones — we don't support nested or overlapping splits.
      await prisma.breakoutGroup.updateMany({
        where: { parentChannelId: channelId, endedAt: null },
        data: { endedAt: new Date() },
      });

      const endsAt = body.minutes
        ? new Date(Date.now() + body.minutes * 60 * 1000)
        : null;

      const created: Array<{
        id: string;
        name: string;
        livekitRoom: string;
        members: string[];
      }> = [];

      for (const g of body.groups) {
        const id = ulid();
        const livekitRoom = `breakout:${id}`;
        await prisma.breakoutGroup.create({
          data: {
            id,
            parentChannelId: channelId,
            name: g.name,
            livekitRoom,
            endsAt,
            createdBy: ctx.userId,
            members: {
              create: g.memberIds.map((userId) => ({ userId })),
            },
          },
        });
        created.push({ id, name: g.name, livekitRoom, members: g.memberIds });
      }

      gatewayBroker.publish({
        type: 'BREAKOUT_OPEN',
        serverId: result.serverId,
        channelId,
        data: {
          parentChannelId: channelId,
          endsAt: endsAt?.toISOString() ?? null,
          groups: created,
        },
      });

      reply.status(201).send(ok({ groups: created.map((g) => g.id) }));
    },
  });

  app.post('/api/breakouts/:id/join', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const group = await prisma.breakoutGroup.findUnique({
      where: { id },
      include: { members: true, parent: { select: { serverId: true, videoEnabled: true } } },
    });
    if (!group || group.endedAt) throw TavernError.notFound('Breakout not found');
    const isAssigned = group.members.some((m) => m.userId === ctx.userId);
    if (!isAssigned) throw TavernError.forbidden('You are not in this breakout');
    if (!cfg.LIVEKIT_URL || !cfg.LIVEKIT_API_KEY || !cfg.LIVEKIT_API_SECRET) {
      throw new TavernError('VOICE_UNAVAILABLE', 'Voice not configured', 503);
    }
    // Issue a fresh LiveKit token bound to the breakout's room name.
    const me = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { displayName: true, username: true },
    });
    const { token, expiresAt } = await signLiveKitToken({
      apiKey: cfg.LIVEKIT_API_KEY,
      apiSecret: cfg.LIVEKIT_API_SECRET,
      identity: ctx.userId,
      name: me?.displayName ?? me?.username ?? 'Tavern user',
      ttlSeconds: 15 * 60,
      grant: {
        roomJoin: true,
        room: group.livekitRoom,
        canPublish: true,
        canPublishData: true,
        canSubscribe: true,
        canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'],
      },
    });
    await prisma.breakoutMember.update({
      where: { groupId_userId: { groupId: id, userId: ctx.userId } },
      data: { joinedAt: new Date() },
    });
    reply.send(
      ok({
        token,
        roomName: group.livekitRoom,
        liveKitUrl: cfg.LIVEKIT_URL,
        expiresAt: expiresAt.toISOString(),
      }),
    );
  });

  app.post('/api/voice/:channelId/breakouts/end-all', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_CHANNELS);
      await prisma.breakoutGroup.updateMany({
        where: { parentChannelId: channelId, endedAt: null },
        data: { endedAt: new Date() },
      });
      gatewayBroker.publish({
        type: 'BREAKOUT_CLOSE',
        serverId: result.serverId,
        channelId,
        data: { parentChannelId: channelId },
      });
      reply.send(ok({ ok: true }));
    },
  });
}

function serialize(row: {
  id: string;
  parentChannelId: string;
  name: string;
  livekitRoom: string;
  endsAt: Date | null;
  createdBy: string;
  members: Array<{ userId: string; joinedAt: Date | null }>;
  createdAt: Date;
}) {
  return {
    id: row.id,
    parentChannelId: row.parentChannelId,
    name: row.name,
    livekitRoom: row.livekitRoom,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    members: row.members.map((m) => ({
      userId: m.userId,
      joinedAt: m.joinedAt?.toISOString() ?? null,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
