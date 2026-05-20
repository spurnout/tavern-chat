import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createChannelRequestSchema,
  idSchema,
  Permission,
  TavernError,
  ulid,
  updateChannelRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeChannel } from '../lib/serializers.js';
import {
  getChannelPermissions,
  requireChannelPermission,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  // Create a channel inside a server ---------------------------------------
  app.post('/api/servers/:serverId/channels', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = createChannelRequestSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_CHANNELS);

    if (body.parentId) {
      const parent = await prisma.channel.findUnique({
        where: { id: body.parentId },
        select: { serverId: true, type: true },
      });
      if (!parent || parent.serverId !== serverId) throw TavernError.validation('Invalid parent channel');
      if (parent.type !== 'category') throw TavernError.validation('Parent must be a category');
    }

    // Compute next position within parent (or root).
    const siblings = await prisma.channel.count({
      where: { serverId, parentId: body.parentId ?? null },
    });

    const channel = await prisma.channel.create({
      data: {
        id: ulid(),
        serverId,
        parentId: body.parentId ?? null,
        type: body.type,
        name: body.name,
        topic: body.topic ?? null,
        nsfw: body.nsfw ?? false,
        videoEnabled: body.videoEnabled ?? true,
        position: siblings,
      },
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'channel.created',
      targetType: 'channel',
      targetId: channel.id,
      metadata: { name: channel.name, type: channel.type },
    });
    gatewayBroker.publish({
      type: 'CHANNEL_CREATE',
      serverId,
      channelId: channel.id,
      data: serializeChannel(channel),
    });

    reply.status(201).send(ok(serializeChannel(channel)));
  });

  // Get a single channel ----------------------------------------------------
  app.get('/api/channels/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(id, ctx.userId, Permission.VIEW_CHANNEL);
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel) throw TavernError.notFound('Channel not found');
    reply.send(ok(serializeChannel(channel)));
  });

  // Update a channel --------------------------------------------------------
  app.patch('/api/channels/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateChannelRequestSchema.parse(req.body);
    const result = await getChannelPermissions(id, ctx.userId);
    if (!result) throw TavernError.notFound('Channel not found');
    if ((result.perms & Permission.VIEW_CHANNEL) !== Permission.VIEW_CHANNEL) {
      throw TavernError.notFound('Channel not found');
    }
    if (
      (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR &&
      (result.perms & Permission.MANAGE_CHANNELS) !== Permission.MANAGE_CHANNELS
    ) {
      throw TavernError.forbidden();
    }

    const updated = await prisma.channel.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.nsfw !== undefined ? { nsfw: body.nsfw } : {}),
        ...(body.videoEnabled !== undefined ? { videoEnabled: body.videoEnabled } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        // Wave 2 #8 / #9 — slow mode and posting scope.
        ...(body.slowmodeSeconds !== undefined ? { slowmodeSeconds: body.slowmodeSeconds } : {}),
        ...(body.postingScope !== undefined ? { postingScope: body.postingScope } : {}),
        // Federation Phase 3 (P3-11) — per-channel federation override.
        ...(body.federationMode !== undefined ? { federationMode: body.federationMode } : {}),
      },
    });
    await writeAuditEntry({
      serverId: result.serverId,
      actorId: ctx.userId,
      action: 'channel.updated',
      targetType: 'channel',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'CHANNEL_UPDATE',
      serverId: result.serverId,
      channelId: id,
      data: serializeChannel(updated),
    });
    reply.send(ok(serializeChannel(updated)));
  });

  // Delete a channel --------------------------------------------------------
  app.delete('/api/channels/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const result = await getChannelPermissions(id, ctx.userId);
    if (!result) throw TavernError.notFound('Channel not found');
    if (
      (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR &&
      (result.perms & Permission.MANAGE_CHANNELS) !== Permission.MANAGE_CHANNELS
    ) {
      throw TavernError.forbidden();
    }
    await prisma.channel.delete({ where: { id } });
    await writeAuditEntry({
      serverId: result.serverId,
      actorId: ctx.userId,
      action: 'channel.deleted',
      targetType: 'channel',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'CHANNEL_DELETE',
      serverId: result.serverId,
      channelId: id,
      data: { id },
    });
    reply.send(ok({ id }));
  });
}
