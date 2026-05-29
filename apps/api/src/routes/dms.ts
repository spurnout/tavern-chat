import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { prisma } from '@tavern/db';
import {
  createDirectDmRequestSchema,
  createGroupDmRequestSchema,
  idSchema,
  listMessagesQuerySchema,
  markDmReadRequestSchema,
  sendDmMessageRequestSchema,
  TavernError,
  ulid,
  updateDmChannelRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import {
  createGroupDm,
  dmChannelWithMembersInclude,
  findOrCreateDirectDm,
  requireDmChannelMembership,
  serializeDmChannel,
  serializeDmChannelRow,
  usersShareServer,
} from '../services/dm-service.js';
import { fanOutDmCreate, fanOutDmMessageCreate } from '../services/federation-outbox.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import type { QueueClient } from '../services/queues.js';

function sanitizeContent(content: string): string {
  return sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} });
}

export interface DmRouteDeps {
  /**
   * Local instance's federation host (e.g. `a.example`). Threaded into
   * `findOrCreateDirectDm` so federated DM pairKeys can be computed from
   * qualified ids. Optional — when null/undefined, federated DM channels
   * fall back to the local-id pairKey (which still works, but the key won't
   * match the one the remote instance computes).
   */
  selfHost?: string | null;
  /**
   * Queue client used by P5-3 to enqueue `dm.create` envelopes when the
   * other party in a 1:1 DM is a remote user. Optional — omitting it
   * (e.g. on a non-federated instance) disables the fan-out branch
   * entirely; the local DM still works.
   */
  queues?: QueueClient;
  /**
   * Instance-level federation gate, threaded into `fanOutDmCreate` as
   * defence-in-depth. Matches the shape used by every other federated
   * route module.
   */
  federationEnabledOnInstance?: boolean;
  /**
   * P5-11 — operator-level opt-out for federated DMs. When false this
   * instance does NOT advertise `dms` in its .well-known capability list
   * AND skips every outbound `fanOutDm*` call before it touches the queue
   * (`dm.*` envelopes from peers are rejected by the inbound dispatcher,
   * not here). Independent of `federationEnabledOnInstance`: with
   * federation fully off this flag is meaningless.
   */
  federationDmsEnabledOnInstance?: boolean;
}

export async function registerDmRoutes(
  app: FastifyInstance,
  deps?: DmRouteDeps,
): Promise<void> {
  // ---- DM channels ---------------------------------------------------------

  // Users I share at least one tavern with — the eligible pool for starting
  // a new DM. Replaces the previous client-side fan-out across every server's
  // `GET /servers/:id/members`, which scaled with how many servers you were in.
  app.get('/api/dms/candidates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const candidates = await prisma.user.findMany({
      where: {
        id: { not: ctx.userId },
        memberships: {
          some: {
            server: { members: { some: { userId: ctx.userId } } },
          },
        },
      },
      select: { id: true, displayName: true, username: true },
      orderBy: [{ displayName: 'asc' }, { username: 'asc' }],
    });
    reply.send(
      ok(
        candidates.map((c) => ({
          userId: c.id,
          displayName: c.displayName,
          username: c.username,
        })),
      ),
    );
  });

  // List my DM channels, sorted by most-recent activity. Loads every
  // channel + its members in a single query (one for the membership lookup,
  // one for the channels) — previously we issued one extra `findUnique` per
  // channel inside `serializeDmChannel`.
  app.get('/api/dms', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const memberships = await prisma.dmChannelMember.findMany({
      where: { userId: ctx.userId },
      select: { dmChannelId: true },
    });
    const ids = memberships.map((m) => m.dmChannelId);
    if (ids.length === 0) {
      reply.send(ok([]));
      return;
    }
    const channels = await prisma.dmChannel.findMany({
      where: { id: { in: ids } },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      include: dmChannelWithMembersInclude,
    });
    const serialized = channels.map((c) =>
      serializeDmChannelRow(c as unknown as Parameters<typeof serializeDmChannelRow>[0], ctx.userId),
    );
    reply.send(ok(serialized));
  });

  // Open or reuse a 1:1 DM with another user.
  app.post('/api/dms/direct', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const body = createDirectDmRequestSchema.parse(req.body);
      // Shared-tavern gate: can't DM someone you've never met.
      const ok2 = await usersShareServer(ctx.userId, body.userId);
      if (!ok2) {
        throw TavernError.forbidden(
          'You can only DM members of a tavern you share',
        );
      }
      const id = await findOrCreateDirectDm(ctx.userId, body.userId, {
        selfHost: deps?.selfHost ?? null,
      });
      const dto = await serializeDmChannel(id, ctx.userId);
      // Notify both members so the channel pops into their list.
      gatewayBroker.publish({
        type: 'DM_CHANNEL_CREATE',
        dmChannelId: id,
        data: dto,
      });

      // P5-3 — federation fan-out. Best-effort: wrapped in try/catch so a
      // federation hiccup never breaks the local DM open. Gated on (a)
      // `selfHost` being known (we can't build qualified ids without it),
      // (b) `queues` being wired, (c) the OTHER member being a remote
      // user (User.remoteInstanceId set + remoteUserId qualified id), and
      // (d) P5-11 — the operator hasn't opted this instance out of
      // federated DMs entirely via `FEDERATION_DMS_ENABLED=false`. We gate
      // at the route level (a single early-return) rather than inside the
      // helper because the helper-level federation flag and per-peer
      // capability check are still useful when the operator is opted in
      // but a particular peer isn't.
      // Re-creates of the same DM channel re-fire `dm.create` — that's
      // fine: the inbound handler is idempotent on (pairKey).
      //
      // KNOWN UX GAP — silent dead-letter on permanent rejection.
      // The BullMQ outbox dispatcher converts permanent (4xx) responses
      // from the peer's inbound `/_federation/inbox` into
      // `FederationOutboxPermanentError` and dead-letters the job. The
      // catch block below only fires for SYNCHRONOUS errors during the
      // enqueue (Prisma lookup failures, queue-not-ready, etc.); it does
      // NOT fire for async delivery failures. The user-visible
      // consequence: the local DmChannel exists, the initiator can write
      // messages, no messages reach the remote recipient, and the UI
      // shows no error. Scenarios that hit this today:
      //   - PF-4 `recipient_refuses_federated_dms` — recipient has the
      //     per-user "accept federated DMs" toggle off on their home
      //     instance, peer's inbound handler returns 403.
      //   - Peer dropped the `dms` capability since last handshake.
      //   - Peer revoked the peering relationship.
      //   - Recipient deleted / suspended on the peer instance.
      // The operator-visible signal in all cases is the dead-letter ring
      // in BullMQ. There is no UI feedback path back to the initiator
      // TODAY — tracked in `docs/federation-followups.md` #34, blocked
      // on dead-letter visibility (#16) or a gateway-publish path that
      // emits `DM_FEDERATION_REFUSED` back to the originator.
      if (
        deps?.selfHost &&
        deps?.queues &&
        deps?.federationDmsEnabledOnInstance !== false
      ) {
        try {
          const initiator = await prisma.user.findUnique({
            where: { id: ctx.userId },
            select: { username: true },
          });
          const other = await prisma.user.findUnique({
            where: { id: body.userId },
            select: { remoteInstanceId: true, remoteUserId: true },
          });
          if (
            initiator &&
            other &&
            other.remoteInstanceId &&
            other.remoteUserId
          ) {
            await fanOutDmCreate({
              queues: deps.queues,
              selfHost: deps.selfHost,
              dmChannelId: id,
              initiatorUserId: ctx.userId,
              initiatorUsername: initiator.username,
              recipientRemoteUserId: other.remoteUserId,
              peerInstanceId: other.remoteInstanceId,
              log: req.log,
              federationEnabledOnInstance: deps.federationEnabledOnInstance,
              federationDmsEnabledOnInstance: deps.federationDmsEnabledOnInstance,
            });
          }
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          // Synchronous enqueue failures only — async delivery failures
          // (peer 403, peer 410, capability mismatch, dead-letter) do
          // NOT come through here, they surface in the BullMQ
          // dead-letter ring. See the block comment above + follow-up
          // #34 for the user-feedback gap.
          req.log.warn(
            {
              err: errObj,
              eventType: 'dm.create',
              dmChannelId: id,
            },
            'dm.create federation fan-out enqueue failed (local DM unaffected; async delivery failures land in the outbox dead-letter ring, not here)',
          );
        }
      }

      reply.send(ok(dto));
    },
  });

  // Create a new group DM.
  app.post('/api/dms/group', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const body = createGroupDmRequestSchema.parse(req.body);
      // Each invitee must share at least one tavern with the creator.
      for (const otherId of body.userIds) {
        const shared = await usersShareServer(ctx.userId, otherId);
        if (!shared) {
          throw TavernError.forbidden(
            `You can only add members of a tavern you share`,
          );
        }
      }
      const id = await createGroupDm(ctx.userId, body.userIds, body.name ?? null);
      const dto = await serializeDmChannel(id, ctx.userId);
      gatewayBroker.publish({
        type: 'DM_CHANNEL_CREATE',
        dmChannelId: id,
        data: dto,
      });
      reply.send(ok(dto));
    },
  });

  // Get one DM channel.
  app.get('/api/dms/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await requireDmChannelMembership(id, ctx.userId);
    const dto = await serializeDmChannel(id, ctx.userId);
    reply.send(ok(dto));
  });

  // Rename a group DM. No-op for direct DMs (they don't carry a name).
  app.patch('/api/dms/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateDmChannelRequestSchema.parse(req.body);
    const channel = await requireDmChannelMembership(id, ctx.userId);
    if (channel.kind !== 'group') {
      throw TavernError.validation('Only group DMs can be renamed');
    }
    await prisma.dmChannel.update({
      where: { id },
      data: { name: body.name },
    });
    const dto = await serializeDmChannel(id, ctx.userId);
    gatewayBroker.publish({
      type: 'DM_CHANNEL_UPDATE',
      dmChannelId: id,
      data: dto,
    });
    reply.send(ok(dto));
  });

  // Mark a DM channel as read.
  app.post('/api/dms/:id/read', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = markDmReadRequestSchema.parse(req.body ?? {});
    await requireDmChannelMembership(id, ctx.userId);
    await prisma.dmChannelMember.update({
      where: { dmChannelId_userId: { dmChannelId: id, userId: ctx.userId } },
      data: { lastReadAt: body.at ? new Date(body.at) : new Date() },
    });
    reply.send(ok({ ok: true }));
  });

  // ---- DM messages ---------------------------------------------------------

  app.get('/api/dms/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await requireDmChannelMembership(id, ctx.userId);
    const query = listMessagesQuerySchema.parse(req.query);

    const messages = await prisma.message.findMany({
      where: {
        dmChannelId: id,
        deletedAt: null,
        ...(query.before ? { id: { lt: query.before } } : {}),
        ...(query.after ? { id: { gt: query.after } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
        author: { select: { id: true, displayName: true, username: true } },
        diceRoll: { select: { resultJson: true, label: true } },
      },
    });

    reply.send(ok(messages.map((m) => serializeMessage(m as MessageRow, ctx.userId))));
  });

  app.post('/api/dms/:id/messages', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id: dmChannelId } = z.object({ id: idSchema }).parse(req.params);
      const body = sendDmMessageRequestSchema.parse(req.body);
      await requireDmChannelMembership(dmChannelId, ctx.userId);

      // Posting lock check matches the server-message route — global lock
      // applies to DMs too.
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { postingLockedUntil: true },
      });
      if (user?.postingLockedUntil && user.postingLockedUntil > new Date()) {
        throw new TavernError('CONTENT_HELD', 'Your posting privileges are temporarily locked', 403);
      }

      // Idempotency via nonce — only replay the same author's live DM send.
      if (body.nonce) {
        const existing = await prisma.message.findUnique({
          where: { dmChannelId_nonce: { dmChannelId, nonce: body.nonce } },
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
            diceRoll: { select: { resultJson: true, label: true } },
          },
        });
        if (existing) {
          if (existing.authorId !== ctx.userId || existing.deletedAt !== null) {
            throw TavernError.validation('Nonce already used');
          }
          reply.status(200).send(ok(serializeMessage(existing as MessageRow, ctx.userId)));
          return;
        }
      }

      if (body.replyToMessageId) {
        const target = await prisma.message.findUnique({
          where: { id: body.replyToMessageId },
          select: { dmChannelId: true, deletedAt: true },
        });
        if (!target || target.dmChannelId !== dmChannelId || target.deletedAt) {
          throw TavernError.validation('Reply target invalid');
        }
      }

      if (body.attachmentIds?.length) {
        const atts = await prisma.attachment.findMany({
          where: { id: { in: body.attachmentIds } },
          select: { id: true, uploaderId: true, status: true, messageId: true },
        });
        if (atts.length !== body.attachmentIds.length) {
          throw TavernError.validation('Unknown attachment');
        }
        for (const a of atts) {
          if (a.uploaderId !== ctx.userId) throw TavernError.forbidden('Attachment owned by another user');
          if (a.messageId !== null) throw TavernError.validation('Attachment already used');
          if (a.status !== 'ready' && a.status !== 'uploaded') {
            throw new TavernError('UPLOAD_NOT_READY', 'Attachment not ready', 400);
          }
        }
      }

      const messageId = ulid();
      const cleanContent = sanitizeContent(body.content);
      const now = new Date();
      const fullRow = await prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: messageId,
            dmChannelId,
            authorId: ctx.userId,
            type: 'default',
            content: cleanContent,
            replyToMessageId: body.replyToMessageId ?? null,
            nonce: body.nonce ?? null,
          },
        });
        if (body.attachmentIds?.length) {
          await tx.attachment.updateMany({
            where: { id: { in: body.attachmentIds } },
            data: { messageId },
          });
        }
        // Bump the DM channel's lastMessageAt so the list re-sorts.
        await tx.dmChannel.update({
          where: { id: dmChannelId },
          data: { lastMessageAt: now },
        });
        return tx.message.findUniqueOrThrow({
          where: { id: messageId },
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
            diceRoll: { select: { resultJson: true, label: true } },
          },
        });
      });

      const dto = serializeMessage(fullRow as MessageRow, ctx.userId);
      gatewayBroker.publish({
        type: 'DM_MESSAGE_CREATE',
        dmChannelId,
        data: dto,
      });

      // P5-5 — federation fan-out for DM messages. Best-effort: wrapped in
      // try/catch so a federation hiccup never breaks the local send. Gated on:
      //   (a) federation deps wired in (`queues` + `selfHost`),
      //   (b) instance-level FEDERATION_ENABLED is not explicitly off
      //       (defence-in-depth also enforced inside the helper),
      //   (c) P5-11 — FEDERATION_DMS_ENABLED hasn't been flipped off (the
      //       operator-level opt-out for federated DMs is independent of the
      //       global federation flag),
      //   (d) the DM is 1:1 (`kind === 'direct'`) — group DM federation is
      //       out of scope for Phase 5,
      //   (e) the OTHER member is a remote user (User.remoteInstanceId set).
      //
      // For (d) + (e) we need to know who the other member is and what
      // kind of channel this is. One extra query against DmChannel pulls
      // both in a single round-trip rather than chasing the existing
      // `fullRow` (which doesn't carry membership info).
      if (
        deps?.queues &&
        deps.selfHost &&
        deps.federationEnabledOnInstance !== false &&
        deps.federationDmsEnabledOnInstance !== false
      ) {
        try {
          const channel = await prisma.dmChannel.findUnique({
            where: { id: dmChannelId },
            select: {
              kind: true,
              members: {
                select: {
                  userId: true,
                  user: {
                    select: {
                      id: true,
                      username: true,
                      remoteInstanceId: true,
                    },
                  },
                },
              },
            },
          });
          // Group DMs do not federate in Phase 5. The wire schema has no
          // notion of group-DM message envelopes; bail out before doing the
          // per-member dance.
          if (channel && channel.kind === 'direct') {
            const otherMembers = channel.members.filter(
              (m) => m.userId !== ctx.userId,
            );
            // 1:1 invariant — exactly one other member. Defensive `[0]` lookup
            // so a malformed row (shouldn't happen) silently skips fan-out
            // rather than throwing in the federation branch.
            const other = otherMembers[0];
            if (other && other.user.remoteInstanceId) {
              // `fullRow.author.username` is already populated by the
              // transaction's include — no extra user lookup needed for the
              // qualified-id construction.
              await fanOutDmMessageCreate({
                queues: deps.queues,
                selfHost: deps.selfHost,
                dmChannelId,
                messageId: fullRow.id,
                authorUserId: ctx.userId,
                authorUsername: fullRow.author.username,
                content: fullRow.content,
                replyToMessageId: fullRow.replyToMessageId,
                createdAt: fullRow.createdAt,
                peerInstanceId: other.user.remoteInstanceId,
                log: req.log,
                federationEnabledOnInstance: deps.federationEnabledOnInstance,
                federationDmsEnabledOnInstance: deps.federationDmsEnabledOnInstance,
              });
            }
          }
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          req.log.warn(
            { err: errObj, dmChannelId, messageId: fullRow.id },
            'dm.message.create federation fan-out failed (local DM unaffected)',
          );
        }
      }

      reply.status(201).send(ok(dto));
    },
  });
}
