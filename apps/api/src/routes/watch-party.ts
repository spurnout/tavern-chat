import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const sourceSchema = z.enum(['mp4', 'youtube', 'hls', 'twitch', 'other']);

const startSchema = z.object({
  videoUrl: z.string().url().max(2000),
  source: sourceSchema,
});

const stateSchema = z.object({
  currentSec: z.number().min(0).max(60 * 60 * 24),
  isPlaying: z.boolean(),
});

/**
 * Wave 3 #26 — watch parties.
 *
 * One active party per voice channel. The host (whoever started it, or any
 * channel manager) drives playback; viewers receive `WATCH_PARTY_STATE`
 * gateway events and seek to keep within ~1 second of the host. Late joiners
 * read the current row via GET and project the position forward by the
 * elapsed time since `lastUpdatedAt`.
 */
export async function registerWatchPartyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/voice/:channelId/watch-party', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);
    const row = await prisma.watchParty.findUnique({ where: { channelId } });
    if (!row) {
      reply.send(ok(null));
      return;
    }
    reply.send(ok(serialize(row)));
  });

  app.post('/api/voice/:channelId/watch-party', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const body = startSchema.parse(req.body);
      // Starting a watch party plays media into the room. Gate behind
      // SPEAK_VOICE — same posture as soundboard cues.
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);
      // Refuse to start a second party in the same channel — explicit end
      // first keeps the UX honest about who owns playback.
      const existing = await prisma.watchParty.findUnique({ where: { channelId } });
      if (existing) {
        throw TavernError.conflict(
          'CONFLICT',
          'A watch party is already running in this room. End it first.',
        );
      }
      const row = await prisma.watchParty.create({
        data: {
          id: ulid(),
          channelId,
          hostUserId: ctx.userId,
          videoUrl: body.videoUrl,
          source: body.source,
          currentSec: 0,
          isPlaying: false,
        },
      });
      gatewayBroker.publish({
        type: 'WATCH_PARTY_START',
        serverId: result.serverId,
        channelId,
        data: serialize(row),
      });
      reply.status(201).send(ok(serialize(row)));
    },
  });

  app.patch('/api/watch-party/:id', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const body = stateSchema.parse(req.body);
      const row = await prisma.watchParty.findUnique({ where: { id } });
      if (!row) throw TavernError.notFound('Watch party not found');
      const isHost = row.hostUserId === ctx.userId;
      if (!isHost) {
        // Non-host updates are rejected — a viewer scrubbing locally must
        // not desync the room. Channel managers can take over via /takeover.
        throw TavernError.forbidden('Only the host can control playback');
      }
      const updated = await prisma.watchParty.update({
        where: { id },
        data: { currentSec: body.currentSec, isPlaying: body.isPlaying },
      });
      const channel = await prisma.channel.findUnique({
        where: { id: row.channelId },
        select: { serverId: true },
      });
      gatewayBroker.publish({
        type: 'WATCH_PARTY_STATE',
        ...(channel ? { serverId: channel.serverId } : {}),
        channelId: row.channelId,
        data: serialize(updated),
      });
      reply.send(ok(serialize(updated)));
    },
  });

  app.post('/api/watch-party/:id/takeover', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.watchParty.findUnique({ where: { id } });
    if (!row) throw TavernError.notFound('Watch party not found');
    // Anyone with MANAGE_CHANNELS in the room can yank control. Useful when
    // the original host disconnects and leaves playback paused mid-scene.
    await requireChannelPermission(row.channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    const updated = await prisma.watchParty.update({
      where: { id },
      data: { hostUserId: ctx.userId },
    });
    const channel = await prisma.channel.findUnique({
      where: { id: row.channelId },
      select: { serverId: true },
    });
    gatewayBroker.publish({
      type: 'WATCH_PARTY_STATE',
      ...(channel ? { serverId: channel.serverId } : {}),
      channelId: row.channelId,
      data: serialize(updated),
    });
    reply.send(ok(serialize(updated)));
  });

  app.delete('/api/watch-party/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.watchParty.findUnique({ where: { id } });
    if (!row) throw TavernError.notFound('Watch party not found');
    if (row.hostUserId !== ctx.userId) {
      // Mods can shut down a party that's run away from the host.
      await requireChannelPermission(row.channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    }
    const channel = await prisma.channel.findUnique({
      where: { id: row.channelId },
      select: { serverId: true },
    });
    await prisma.watchParty.delete({ where: { id } });
    gatewayBroker.publish({
      type: 'WATCH_PARTY_END',
      ...(channel ? { serverId: channel.serverId } : {}),
      channelId: row.channelId,
      data: { channelId: row.channelId },
    });
    reply.send(ok({ id }));
  });
}

function serialize(row: {
  id: string;
  channelId: string;
  hostUserId: string;
  videoUrl: string;
  source: string;
  startedAt: Date;
  currentSec: number;
  isPlaying: boolean;
  lastUpdatedAt: Date;
}) {
  return {
    id: row.id,
    channelId: row.channelId,
    hostUserId: row.hostUserId,
    videoUrl: row.videoUrl,
    source: row.source,
    startedAt: row.startedAt.toISOString(),
    currentSec: row.currentSec,
    isPlaying: row.isPlaying,
    lastUpdatedAt: row.lastUpdatedAt.toISOString(),
  };
}
