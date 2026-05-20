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
import {
  fanOutChannelCreate,
  fanOutChannelDelete,
  fanOutChannelUpdate,
} from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';

export interface ChannelRouteDeps {
  /**
   * Queue client used to enqueue outbound federation envelopes for the P4-9
   * channel-lifecycle fan-out (channel.create/update/delete). Optional —
   * when omitted (or when `selfHost` is missing), the federation hook
   * short-circuits and the local CHANNEL_* broadcasts are unaffected.
   */
  queues?: QueueClient;
  /** The local instance's federation host (e.g. `a.example`). */
  selfHost?: string | null;
  /**
   * The instance-level FEDERATION_ENABLED flag. Threaded through to the
   * fan-out helpers as defence-in-depth: even if `queues` / `selfHost` end up
   * wired in on a non-federated instance, the helper short-circuits when
   * this is `false`.
   */
  federationEnabledOnInstance?: boolean;
}

export async function registerChannelRoutes(
  app: FastifyInstance,
  deps?: ChannelRouteDeps,
): Promise<void> {
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

    // Pre-create read — we need the parent server's federation flag and
    // originInstanceId so we can gate the fan-out below. Pulled separately
    // so the create's `data` clause stays a pure shape.
    const serverRow = await prisma.server.findUnique({
      where: { id: serverId },
      select: {
        id: true,
        ownerUserId: true,
        federationEnabled: true,
        originInstanceId: true,
      },
    });
    if (!serverRow) throw TavernError.notFound('Server not found');

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

    // P4-9 — fan out new federation-eligible channels to peers with a member
    // in this server. Gated on:
    //   1. Deps wired in (FEDERATION_ENABLED at the instance level)
    //   2. Server is federated AND not a mirror of someone else's server
    //   3. Channel type is text or forum — the wire schema only models those
    //      two types, the others (voice / category / etc) are per-instance
    //      state and not part of the mirror surface.
    if (
      deps?.queues &&
      deps.selfHost &&
      serverRow.federationEnabled &&
      serverRow.originInstanceId === null &&
      (channel.type === 'text' || channel.type === 'forum')
    ) {
      try {
        const owner = await prisma.user.findUnique({
          where: { id: serverRow.ownerUserId },
          select: { username: true },
        });
        if (owner) {
          await fanOutChannelCreate({
            queues: deps.queues,
            selfHost: deps.selfHost,
            serverId,
            ownerUserId: serverRow.ownerUserId,
            ownerUsername: owner.username,
            channel: {
              id: channel.id,
              name: channel.name,
              type: channel.type,
              topic: channel.topic,
              position: channel.position,
              federationMode: channel.federationMode,
              nsfw: channel.nsfw,
            },
            log: app.log,
            federationEnabledOnInstance: deps.federationEnabledOnInstance,
          });
        }
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        app.log.warn(
          { err: errObj, channelId: channel.id, serverId },
          'federation fan-out failed for channel.create',
        );
      }
    }

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

    // Pre-PATCH read — pull the channel's type + the parent server's
    // federation flag + originInstanceId so the post-publish fan-out gate
    // doesn't need a second round-trip. The PATCH itself runs on the next
    // line; this is a single extra read and not the hot path.
    const beforeRow = await prisma.channel.findUnique({
      where: { id },
      select: {
        type: true,
        server: {
          select: {
            ownerUserId: true,
            federationEnabled: true,
            originInstanceId: true,
          },
        },
      },
    });
    if (!beforeRow) throw TavernError.notFound('Channel not found');

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

    // P4-9 — fan out the channel update to every peered instance that has a
    // member in this server. Critically, this fires REGARDLESS of effective
    // per-channel federation as long as the SERVER is federated: a channel
    // toggling its `federationMode` (including flipping to `force_off`) is
    // itself the event peers must learn about — without it, peers would
    // keep expecting messages on a room that has gone silent.
    //
    // Gated on:
    //   1. Deps wired in (FEDERATION_ENABLED at the instance level)
    //   2. Parent server is federated AND not a mirror
    //   3. Channel type is text or forum (the only federation-eligible types)
    if (
      deps?.queues &&
      deps.selfHost &&
      beforeRow.server?.federationEnabled &&
      beforeRow.server.originInstanceId === null &&
      (beforeRow.type === 'text' || beforeRow.type === 'forum')
    ) {
      try {
        const owner = await prisma.user.findUnique({
          where: { id: beforeRow.server.ownerUserId },
          select: { username: true },
        });
        if (owner) {
          await fanOutChannelUpdate({
            queues: deps.queues,
            selfHost: deps.selfHost,
            serverId: result.serverId,
            channelId: id,
            ownerUserId: beforeRow.server.ownerUserId,
            ownerUsername: owner.username,
            name: body.name,
            topic: body.topic,
            position: body.position,
            federationMode: body.federationMode,
            nsfw: body.nsfw,
            log: app.log,
            federationEnabledOnInstance: deps.federationEnabledOnInstance,
          });
        }
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        app.log.warn(
          { err: errObj, channelId: id, serverId: result.serverId },
          'federation fan-out failed for channel.update',
        );
      }
    }

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

    // Pre-DELETE read — same shape as the PATCH handler's `beforeRow`,
    // needed so the fan-out gate can decide BEFORE the row is gone. We
    // can't read these after the delete: Prisma's `delete` doesn't return
    // the row's relations.
    const beforeRow = await prisma.channel.findUnique({
      where: { id },
      select: {
        type: true,
        server: {
          select: {
            ownerUserId: true,
            federationEnabled: true,
            originInstanceId: true,
          },
        },
      },
    });
    if (!beforeRow) throw TavernError.notFound('Channel not found');

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

    // P4-9 — fan out the deletion. Same gating as channel.update; effective
    // per-channel federation doesn't matter (a deleted channel is by
    // definition no longer producing messages, and peers need to know to
    // tear down their mirror channel row).
    if (
      deps?.queues &&
      deps.selfHost &&
      beforeRow.server?.federationEnabled &&
      beforeRow.server.originInstanceId === null &&
      (beforeRow.type === 'text' || beforeRow.type === 'forum')
    ) {
      try {
        const owner = await prisma.user.findUnique({
          where: { id: beforeRow.server.ownerUserId },
          select: { username: true },
        });
        if (owner) {
          await fanOutChannelDelete({
            queues: deps.queues,
            selfHost: deps.selfHost,
            serverId: result.serverId,
            channelId: id,
            ownerUserId: beforeRow.server.ownerUserId,
            ownerUsername: owner.username,
            log: app.log,
            federationEnabledOnInstance: deps.federationEnabledOnInstance,
          });
        }
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        app.log.warn(
          { err: errObj, channelId: id, serverId: result.serverId },
          'federation fan-out failed for channel.delete',
        );
      }
    }

    reply.send(ok({ id }));
  });
}
