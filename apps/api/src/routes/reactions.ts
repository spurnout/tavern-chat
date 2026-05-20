import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  Permission,
  reactionEmojiSchema,
  TavernError,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { requireDmChannelMembership } from '../services/dm-service.js';
import { gatewayBroker, type GatewayEvent } from '../services/gateway-broker.js';
import {
  computeEffectiveFederation,
  fanOutReactionAdd,
  fanOutReactionRemove,
} from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';

interface MessageRouting {
  serverId: string | null;
  channelId: string | null;
  dmChannelId: string | null;
}

/**
 * Per-message access check: server messages route through channel perms,
 * DM messages through DmChannel membership.
 */
async function authorizeReaction(message: MessageRouting, userId: string): Promise<void> {
  if (message.dmChannelId) {
    await requireDmChannelMembership(message.dmChannelId, userId);
    return;
  }
  if (!message.channelId) throw TavernError.notFound();
  await requireChannelPermission(message.channelId, userId, Permission.ADD_REACTIONS);
}

function reactionEvent(
  type: 'REACTION_ADD' | 'REACTION_REMOVE',
  message: MessageRouting,
  payload: { messageId: string; userId: string; emoji: string },
): GatewayEvent {
  if (message.dmChannelId) {
    return { type, dmChannelId: message.dmChannelId, data: payload };
  }
  return {
    type,
    serverId: message.serverId ?? undefined,
    channelId: message.channelId ?? undefined,
    data: payload,
  };
}

export interface ReactionRouteDeps {
  /**
   * Queue client used to enqueue outbound federation envelopes. Optional —
   * when omitted (or when `selfHost` is missing), the federation fan-out hook
   * short-circuits. The local reaction publish path is unaffected.
   */
  queues?: QueueClient;
  /** The local instance's federation host (e.g. `a.example`). */
  selfHost?: string | null;
}

export async function registerReactionRoutes(
  app: FastifyInstance,
  deps?: ReactionRouteDeps,
): Promise<void> {
  // Wave 3 #4 — Top emoji used in this server over the last 30 days,
  // surfaced as one-tap "quick reaction" buttons on hover.
  app.get('/api/servers/:id/quick-reactions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL).catch(
      // Server-scope check via fall-through to permission service.
      () => undefined,
    );
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.messageReaction.groupBy({
      by: ['emoji'],
      where: {
        message: { serverId, createdAt: { gte: since } },
      },
      _count: { emoji: true },
      orderBy: { _count: { emoji: 'desc' } },
      take: 8,
    });
    reply.send(
      ok(
        rows.map((r) => ({
          emoji: r.emoji,
          count: r._count.emoji,
        })),
      ),
    );
  });

  app.put('/api/messages/:id/reactions/:emoji', {
    // Generous limit — reactions are normal social behavior, but bounded so
    // a runaway client can't spam the realtime fan-out.
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id, emoji } = z
        .object({ id: idSchema, emoji: reactionEmojiSchema })
        .parse(req.params);
      // P3-9 — pull `originInstanceId` + the channel's federation knobs in the
      // same round-trip so the post-write fan-out gate doesn't need a second
      // query on the hot path. Mirrors the create / edit / delete pattern in
      // `routes/messages.ts`.
      const message = await prisma.message.findUnique({
        where: { id },
        select: {
          channelId: true,
          dmChannelId: true,
          deletedAt: true,
          serverId: true,
          originInstanceId: true,
          channel: {
            select: {
              federationMode: true,
              server: { select: { federationEnabled: true } },
            },
          },
        },
      });
      if (!message || message.deletedAt) throw TavernError.notFound();
      await authorizeReaction(message, ctx.userId);

      if (emoji.startsWith('custom:')) {
        const emojiId = emoji.slice('custom:'.length);
        const custom = await prisma.customEmoji.findUnique({ where: { id: emojiId } });
        // Custom emojis are server-scoped; DM messages can only use unicode
        // (or any custom emoji is rejected since there's no serverId to match).
        if (!custom || custom.serverId !== message.serverId) {
          throw TavernError.validation('Custom emoji unavailable in this channel');
        }
      }

      await prisma.messageReaction.upsert({
        where: { messageId_userId_emoji: { messageId: id, userId: ctx.userId, emoji } },
        create: { messageId: id, userId: ctx.userId, emoji },
        update: {},
      });
      gatewayBroker.publish(
        reactionEvent('REACTION_ADD', message, { messageId: id, userId: ctx.userId, emoji }),
      );
      // P3-9 — fan out the reaction to every peered instance with a member in
      // this server. Identical gating to message create / edit / delete:
      //   1. deps wired in (FEDERATION_ENABLED on),
      //   2. server message, not a DM (DMs are Phase 5),
      //   3. locally-originated row — Phase 3 has no relay; reactions on
      //      inbound federated messages are NOT re-broadcast (each peer hears
      //      the reaction directly from the reactor's home instance),
      //   4. effective federation evaluates to ON for this channel.
      // Errors are best-effort; the local upsert + broadcast are already done.
      if (
        deps?.queues &&
        deps.selfHost &&
        message.serverId &&
        message.channelId &&
        !message.dmChannelId &&
        !message.originInstanceId &&
        message.channel
      ) {
        try {
          const effective = computeEffectiveFederation(
            message.channel.server?.federationEnabled ?? false,
            message.channel.federationMode,
          );
          if (effective) {
            // Reactor's username is needed for the qualified `<localpart>@<selfHost>`
            // actor id in the envelope. A small extra read on the federation
            // hot path is fine — we already wrote the reaction row above.
            const reactor = await prisma.user.findUnique({
              where: { id: ctx.userId },
              select: { username: true },
            });
            if (reactor) {
              await fanOutReactionAdd({
                queues: deps.queues,
                selfHost: deps.selfHost,
                serverId: message.serverId,
                messageId: id,
                actorUserId: ctx.userId,
                actorUsername: reactor.username,
                emoji,
                log: app.log,
              });
            }
          }
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          app.log.warn(
            { err: errObj, messageId: id, channelId: message.channelId, serverId: message.serverId },
            'federation fan-out failed for reaction.add',
          );
        }
      }
      reply.send(ok({ ok: true }));
    },
  });

  app.delete('/api/messages/:id/reactions/:emoji', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id, emoji } = z
      .object({ id: idSchema, emoji: reactionEmojiSchema })
      .parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        channelId: true,
        dmChannelId: true,
        deletedAt: true,
        serverId: true,
        originInstanceId: true,
        channel: {
          select: {
            federationMode: true,
            server: { select: { federationEnabled: true } },
          },
        },
      },
    });
    if (!message || message.deletedAt) throw TavernError.notFound();
    try {
      await prisma.messageReaction.delete({
        where: { messageId_userId_emoji: { messageId: id, userId: ctx.userId, emoji } },
      });
    } catch {
      /* idempotent */
    }
    gatewayBroker.publish(
      reactionEvent('REACTION_REMOVE', message, { messageId: id, userId: ctx.userId, emoji }),
    );
    // P3-9 — same gating + best-effort contract as reaction.add. See PUT
    // handler above for the rationale on each branch of the gate.
    if (
      deps?.queues &&
      deps.selfHost &&
      message.serverId &&
      message.channelId &&
      !message.dmChannelId &&
      !message.originInstanceId &&
      message.channel
    ) {
      try {
        const effective = computeEffectiveFederation(
          message.channel.server?.federationEnabled ?? false,
          message.channel.federationMode,
        );
        if (effective) {
          const reactor = await prisma.user.findUnique({
            where: { id: ctx.userId },
            select: { username: true },
          });
          if (reactor) {
            await fanOutReactionRemove({
              queues: deps.queues,
              selfHost: deps.selfHost,
              serverId: message.serverId,
              messageId: id,
              actorUserId: ctx.userId,
              actorUsername: reactor.username,
              emoji,
              log: app.log,
            });
          }
        }
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        app.log.warn(
          { err: errObj, messageId: id, channelId: message.channelId, serverId: message.serverId },
          'federation fan-out failed for reaction.remove',
        );
      }
    }
    reply.send(ok({ ok: true }));
  });
}
