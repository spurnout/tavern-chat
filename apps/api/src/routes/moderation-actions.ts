import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  requireChannelPermission,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { fanOutMemberRemove } from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';

const timeoutBodySchema = z.object({
  untilIso: z.string().datetime(),
  reason: z.string().max(280).optional(),
});

const bulkDeleteBodySchema = z.object({
  messageIds: z.array(idSchema).min(1).max(100),
});

export interface ModerationActionRouteDeps {
  /**
   * Queue client for the P4-10 `member.remove` fan-out on the kick path.
   * Optional — when omitted (or when `selfHost` is missing) the hook
   * short-circuits.
   */
  queues?: QueueClient;
  /** This instance's federation host (e.g. `a.example`). */
  selfHost?: string | null;
  /**
   * Instance-level FEDERATION_ENABLED flag — threaded through to the
   * fan-out helper as defence-in-depth.
   */
  federationEnabledOnInstance?: boolean;
}

/**
 * Wave 2 moderation actions: timeout, kick, bulk delete, edit history.
 * Slowmode and read-only enforcement happen in `messages.ts`; this file is
 * for the dedicated operator endpoints.
 */
export async function registerModerationActionRoutes(
  app: FastifyInstance,
  deps?: ModerationActionRouteDeps,
): Promise<void> {
  // ---- W2 #6 — Timeout / un-timeout a member ----------------------------
  app.post('/api/servers/:id/members/:userId/timeout', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId, userId } = z
      .object({ id: idSchema, userId: idSchema })
      .parse(req.params);
    const body = timeoutBodySchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.TIMEOUT_MEMBERS);

    if (userId === ctx.userId) {
      throw TavernError.validation('You cannot time yourself out');
    }
    const target = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (!target) throw TavernError.notFound('Member not found');

    const until = new Date(body.untilIso);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw TavernError.validation('untilIso must be in the future');
    }
    await prisma.serverMember.update({
      where: { serverId_userId: { serverId, userId } },
      data: { timeoutUntil: until },
    });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'member.timeout',
      targetType: 'user',
      targetId: userId,
      metadata: { untilIso: until.toISOString(), reason: body.reason ?? null },
    });
    gatewayBroker.publish({
      type: 'MEMBER_TIMEOUT',
      serverId,
      userId,
      data: {
        serverId,
        userId,
        timeoutUntil: until.toISOString(),
        reason: body.reason ?? null,
      },
    });
    reply.send(ok({ userId, timeoutUntil: until.toISOString() }));
  });

  app.delete('/api/servers/:id/members/:userId/timeout', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId, userId } = z
      .object({ id: idSchema, userId: idSchema })
      .parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.TIMEOUT_MEMBERS);
    await prisma.serverMember.update({
      where: { serverId_userId: { serverId, userId } },
      data: { timeoutUntil: null },
    });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'member.timeout_clear',
      targetType: 'user',
      targetId: userId,
    });
    gatewayBroker.publish({
      type: 'MEMBER_TIMEOUT',
      serverId,
      userId,
      data: { serverId, userId, timeoutUntil: null, reason: null },
    });
    reply.send(ok({ userId, timeoutUntil: null }));
  });

  // ---- W2 #7 — Kick a member -------------------------------------------
  app.post('/api/servers/:id/members/:userId/kick', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId, userId } = z
      .object({ id: idSchema, userId: idSchema })
      .parse(req.params);
    const body = z.object({ reason: z.string().max(280).optional() }).parse(req.body ?? {});
    await requireServerPermission(serverId, ctx.userId, Permission.KICK_MEMBERS);

    if (userId === ctx.userId) {
      throw TavernError.validation('You cannot kick yourself');
    }
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (!member) throw TavernError.notFound('Member not found');

    // Pre-delete read: we need the parent server's federation state for
    // the P4-10 fan-out gate, the target user's qualified id for the wire
    // payload, AND the target's remote-instance id so the fan-out can
    // ensure the user's home learns about the removal even when they
    // were the last remote member from that peer. Folded into a single
    // findUniqueOrThrow so the existing owner-check still runs.
    const server = await prisma.server.findUniqueOrThrow({
      where: { id: serverId },
      select: {
        ownerUserId: true,
        federationEnabled: true,
        originInstanceId: true,
      },
    });
    if (server.ownerUserId === userId) {
      throw TavernError.forbidden('The server owner cannot be kicked');
    }

    // Capture the target's identity BEFORE the delete so the fan-out can
    // build the qualified `localpart@host` id. For local users the host
    // is `selfHost`; for synthetic remote users the host is the user's
    // home instance (from RemoteUser.remoteUserId). Reading inline keeps
    // the delete + read pair simple at the cost of an extra round-trip.
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, remoteUserId: true, remoteInstanceId: true },
    });

    await prisma.$transaction([
      prisma.serverMemberRole.deleteMany({ where: { serverId, userId } }),
      prisma.serverMember.delete({ where: { serverId_userId: { serverId, userId } } }),
    ]);
    const removedAt = new Date();
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'member.kick',
      targetType: 'user',
      targetId: userId,
      metadata: { reason: body.reason ?? null },
    });
    gatewayBroker.publish({
      type: 'MEMBER_REMOVE',
      serverId,
      data: { serverId, userId },
    });

    // P4-10 — fan out `member.remove` to peers. Same gating as the
    // member.add fan-out elsewhere: server must be federated AND not a
    // mirror, deps wired in at the route layer. The removed user's home
    // peer (if remote) is unioned into the peer set so it learns about
    // the kick even if it had no other members in T.
    if (
      deps?.queues &&
      deps.selfHost &&
      server.federationEnabled &&
      server.originInstanceId === null &&
      target
    ) {
      try {
        const memberRemoteUserId =
          target.remoteUserId ?? `${target.username}@${deps.selfHost}`;
        await fanOutMemberRemove({
          queues: deps.queues,
          selfHost: deps.selfHost,
          serverId,
          memberRemoteUserId,
          reason: 'kicked',
          removedAt,
          actorUserId: ctx.userId,
          log: app.log,
          additionalPeerInstanceIds: target.remoteInstanceId
            ? [target.remoteInstanceId]
            : [],
          federationEnabledOnInstance: deps.federationEnabledOnInstance,
        });
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        app.log.warn(
          { err: errObj, serverId, userId },
          'federation fan-out failed for member.remove (kick)',
        );
      }
    }

    reply.send(ok({ userId }));
  });

  // ---- W2 #10 — Bulk message delete ------------------------------------
  app.post('/api/channels/:id/messages/bulk-delete', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = bulkDeleteBodySchema.parse(req.body);
    const result = await requireChannelPermission(
      channelId,
      ctx.userId,
      Permission.MANAGE_MESSAGES,
    );

    const messages = await prisma.message.findMany({
      where: { id: { in: body.messageIds }, channelId, deletedAt: null },
      select: { id: true },
    });
    if (messages.length === 0) {
      reply.send(ok({ deleted: 0 }));
      return;
    }
    const ids = messages.map((m) => m.id);
    const deletedAt = new Date();
    await prisma.message.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt, content: '' },
    });
    if (result.serverId) {
      await writeAuditEntry({
        serverId: result.serverId,
        actorId: ctx.userId,
        action: 'message.bulk_delete',
        targetType: 'channel',
        targetId: channelId,
        metadata: { count: ids.length, messageIds: ids.slice(0, 50) },
      });
    }
    for (const id of ids) {
      gatewayBroker.publish({
        type: 'MESSAGE_DELETE',
        serverId: result.serverId ?? undefined,
        channelId,
        data: { id, channelId, deletedAt: deletedAt.toISOString() },
      });
    }
    reply.send(ok({ deleted: ids.length }));
  });

  // ---- W2 #10 — Edit history --------------------------------------------
  app.get('/api/messages/:id/edits', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        authorId: true,
        channelId: true,
        dmChannelId: true,
        deletedAt: true,
      },
    });
    if (!message || message.deletedAt) throw TavernError.notFound('Message not found');

    // Author or MANAGE_MESSAGES in the channel can read history.
    if (message.authorId !== ctx.userId) {
      if (!message.channelId) throw TavernError.forbidden();
      await requireChannelPermission(message.channelId, ctx.userId, Permission.MANAGE_MESSAGES);
    }

    const edits = await prisma.messageEdit.findMany({
      where: { messageId: id },
      orderBy: { editedAt: 'asc' },
      include: { editor: { select: { id: true, displayName: true } } },
    });
    reply.send(
      ok(
        edits.map((e) => ({
          id: e.id,
          messageId: e.messageId,
          content: e.content,
          editedAt: e.editedAt.toISOString(),
          editor: { id: e.editor.id, displayName: e.editor.displayName },
        })),
      ),
    );
  });
}
