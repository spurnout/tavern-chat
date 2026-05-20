import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import {
  createMessageRequestSchema,
  hasFlag,
  hasGroupMention,
  idSchema,
  listMessagesQuerySchema,
  nameMentions,
  parseMentions,
  Permission,
  TavernError,
  ulid,
  updateMessageRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import {
  getChannelPermissions,
  requireChannelPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import {
  resolveMentionRecipients,
  resolveQualifiedMentionsAsync,
  writeMentionRecords,
} from '../services/mentions-service.js';
import type { FederationProfileService } from '../services/federation-profile.js';
import {
  computeEffectiveFederation,
  fanOutMessageCreate,
} from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';
import { enqueueLinkPreviews } from '../services/link-preview-service.js';
import { evaluateAutomod } from '../services/automod-service.js';

/**
 * Server-side content sanitiser. Tavern stores raw user text and does its
 * actual HTML rendering on the client, but we still strip outright HTML to
 * prevent inadvertent injection if someone displays content unsafely.
 *
 * No tags, no attributes, no scripts. Plain text only.
 */
function sanitizeContent(content: string): string {
  return sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} });
}

interface MessageRouteDeps {
  federationProfile?: FederationProfileService | null;
  /**
   * Queue client used to enqueue outbound federation envelopes. Optional —
   * when omitted (or when `selfHost` is missing), the federation fan-out hook
   * short-circuits. The local message create / broadcast path is unaffected.
   */
  queues?: QueueClient;
  /** The local instance's federation host (e.g. `a.example`). */
  selfHost?: string | null;
}

export async function registerMessageRoutes(app: FastifyInstance, deps?: MessageRouteDeps): Promise<void> {
  // List messages in a channel ---------------------------------------------
  app.get('/api/channels/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.READ_MESSAGE_HISTORY);

    const query = listMessagesQuerySchema.parse(req.query);

    const where = {
      channelId,
      deletedAt: null,
      ...(query.before ? { id: { lt: query.before } } : {}),
      ...(query.after ? { id: { gt: query.after } } : {}),
    };

    // When `after` is set, the page is the N OLDEST messages newer than the
    // cursor (a contiguous forward-scroll slice). Sorting `desc` here would
    // instead return the N globally newest messages where id > after, which
    // can skip messages in busy channels and break jump-to-message. Sort asc
    // and reverse before send so the response always lands in newest-first
    // order (consistent with the `before` / no-cursor paths).
    const useAscOrder = Boolean(query.after) && !query.before;

    const messages = await prisma.message.findMany({
      where,
      orderBy: { id: useAscOrder ? 'asc' : 'desc' },
      take: query.limit,
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
        author: { select: { id: true, displayName: true, username: true } },
        poll: { select: { id: true } },
        replyTo: {
          select: {
            id: true,
            content: true,
            deletedAt: true,
            author: { select: { displayName: true } },
          },
        },
        forwardedFrom: {
          select: {
            id: true,
            channelId: true,
            author: { select: { displayName: true } },
          },
        },
      },
    });

    const ordered = useAscOrder ? [...messages].reverse() : messages;
    reply.send(ok(ordered.map((m: MessageRow) => serializeMessage(m, ctx.userId))));
  });

  // Create a message --------------------------------------------------------
  app.post('/api/channels/:id/messages', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = createMessageRequestSchema.parse(req.body);

    const result = await requireChannelPermission(channelId, ctx.userId, Permission.SEND_MESSAGES);
    const isAdminOrModForChannel =
      hasFlag(result.perms, Permission.ADMINISTRATOR) ||
      hasFlag(result.perms, Permission.MANAGE_MESSAGES);

    // Posting lock check (Phase 2 trust & safety integration).
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { postingLockedUntil: true },
    });
    if (user?.postingLockedUntil && user.postingLockedUntil > new Date()) {
      throw new TavernError('CONTENT_HELD', 'Your posting privileges are temporarily locked', 403);
    }

    // Wave 2 #6 — server-member timeout gate.
    if (result.serverId) {
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: result.serverId, userId: ctx.userId } },
        select: { timeoutUntil: true },
      });
      if (member?.timeoutUntil && member.timeoutUntil > new Date()) {
        throw new TavernError(
          'MEMBER_TIMED_OUT',
          'You are timed out in this tavern',
          403,
        );
      }
    }

    // Wave 2 #8 + #9 — slow mode and posting scope per channel.
    // Wave 3 #8 also needs the channel `type` so we can auto-seed a thread
    // when this message is the root of a new forum post.
    const channelMeta = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        slowmodeSeconds: true,
        postingScope: true,
        type: true,
        // Federation Phase 3: per-channel override (`inherit | force_on |
        // force_off`). Combined with Server.federationEnabled at fan-out time.
        federationMode: true,
      },
    });
    if (channelMeta) {
      if (channelMeta.postingScope === 'mods_only' && !isAdminOrModForChannel) {
        throw new TavernError(
          'CHANNEL_READ_ONLY',
          'This room is mods-only — only moderators can post here',
          403,
        );
      }
      if (
        channelMeta.postingScope === 'admin_only' &&
        !hasFlag(result.perms, Permission.ADMINISTRATOR)
      ) {
        throw new TavernError(
          'CHANNEL_READ_ONLY',
          'This room is admin-only',
          403,
        );
      }
      if (channelMeta.slowmodeSeconds > 0 && !isAdminOrModForChannel) {
        const lastBy = await prisma.message.findFirst({
          where: { channelId, authorId: ctx.userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        if (lastBy) {
          const elapsedMs = Date.now() - lastBy.createdAt.getTime();
          const requiredMs = channelMeta.slowmodeSeconds * 1000;
          if (elapsedMs < requiredMs) {
            throw new TavernError(
              'SLOWMODE_ACTIVE',
              `Slow mode is on — wait ${Math.ceil((requiredMs - elapsedMs) / 1000)}s`,
              429,
            );
          }
        }
      }
    }

    // Idempotency via nonce: if the same (channelId, nonce) was used recently,
    // return the existing message.
    if (body.nonce) {
      const existing = await prisma.message.findUnique({
        where: { channelId_nonce: { channelId, nonce: body.nonce } },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
          poll: { select: { id: true } },
          replyTo: {
            select: {
              id: true,
              content: true,
              deletedAt: true,
              author: { select: { displayName: true } },
            },
          },
          forwardedFrom: {
            select: {
              id: true,
              channelId: true,
              author: { select: { displayName: true } },
            },
          },
        },
      });
      if (existing) {
        reply.status(200).send(ok(serializeMessage(existing as MessageRow, ctx.userId)));
        return;
      }
    }

    if (body.replyToMessageId) {
      const target = await prisma.message.findUnique({
        where: { id: body.replyToMessageId },
        select: { channelId: true, deletedAt: true },
      });
      if (!target || target.channelId !== channelId || target.deletedAt) {
        throw TavernError.validation('Reply target invalid');
      }
    }

    // Wave 2 #5 — validate forward source: user must be able to view the
    // source channel (server channel or DM they're a member of). Forwarding
    // own DMs into a server room is allowed but the audit log records it.
    let forwardedFromChannelId: string | null = null;
    if (body.forwardedFromMessageId) {
      const source = await prisma.message.findUnique({
        where: { id: body.forwardedFromMessageId },
        select: {
          id: true,
          channelId: true,
          dmChannelId: true,
          deletedAt: true,
        },
      });
      if (!source || source.deletedAt) {
        throw TavernError.validation('Forward source not found');
      }
      if (source.channelId) {
        await requireChannelPermission(source.channelId, ctx.userId, Permission.VIEW_CHANNEL);
        forwardedFromChannelId = source.channelId;
      } else if (source.dmChannelId) {
        const m = await prisma.dmChannelMember.findUnique({
          where: {
            dmChannelId_userId: { dmChannelId: source.dmChannelId, userId: ctx.userId },
          },
        });
        if (!m) throw TavernError.forbidden('You cannot forward from that conversation');
      }
    }

    // Wave 3 #15 — auto-moderation. Evaluate before persisting; an
    // automod hit short-circuits the route with a polite error and writes
    // an audit entry (which mirrors to the mod-log channel if configured).
    if (result.serverId && !isAdminOrModForChannel) {
      const hit = await evaluateAutomod({
        serverId: result.serverId,
        userId: ctx.userId,
        content: body.content,
      });
      if (hit) {
        await writeAuditEntry({
          serverId: result.serverId,
          actorId: ctx.userId,
          action: 'automod.hit',
          targetType: 'channel',
          targetId: channelId,
          metadata: {
            ruleId: hit.rule.id,
            ruleName: hit.rule.name,
            action: hit.rule.action,
            reason: hit.rule.reason ?? null,
          },
        });
        if (hit.rule.action === 'delete' || hit.rule.action === 'hold') {
          throw new TavernError(
            'CONTENT_HELD',
            hit.rule.reason ?? `Blocked by ${hit.rule.name}`,
            403,
          );
        }
        // For warn/timeout/log_only we let the message through; the audit
        // entry is the record of what happened. A follow-up wires
        // warn/timeout to actually escalate; for now operators see the hit.
      }
    }

    // Group / role mention gating. @everyone and @here always require
    // MENTION_EVERYONE. Role mentions require MENTION_EVERYONE unless the
    // role is explicitly `mentionable`. ADMINISTRATOR bypasses both.
    const parsedMentions = parseMentions(body.content);
    const isAdmin = hasFlag(result.perms, Permission.ADMINISTRATOR);
    const canMentionEveryone =
      isAdmin || hasFlag(result.perms, Permission.MENTION_EVERYONE);
    if (hasGroupMention(parsedMentions) && !canMentionEveryone) {
      throw TavernError.forbidden('You cannot use @everyone or @here in this room');
    }
    const candidateNames = nameMentions(parsedMentions);
    if (candidateNames.length > 0 && result.serverId && !canMentionEveryone) {
      const nonMentionableRoles = await prisma.role.findMany({
        where: {
          serverId: result.serverId,
          name: { in: candidateNames },
          mentionable: false,
        },
        select: { name: true },
      });
      if (nonMentionableRoles.length > 0) {
        throw TavernError.forbidden(
          `Role @${nonMentionableRoles[0]?.name} is not mentionable here`,
        );
      }
    }

    // Validate attachment ownership + readiness.
    if (body.attachmentIds?.length) {
      if (
        (result.perms & Permission.ATTACH_FILES) !== Permission.ATTACH_FILES &&
        (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR
      ) {
        throw TavernError.forbidden('You cannot attach files in this channel');
      }
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
    // Captured outside the transaction so the post-commit fanout can emit
    // MENTION_CREATE events keyed by recipient.
    let mentionRecipientIds: Array<{ userId: string; kind: 'user' | 'role' | 'everyone' | 'here' }> = [];
    // DB-004: do the include-fetch inside the transaction after attachments
    // are linked, eliminating the prior post-commit findUnique round-trip
    // (which was a hot-path extra DB hit on every message send).
    const fullRow = await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: messageId,
          serverId: result.serverId,
          channelId,
          authorId: ctx.userId,
          type: 'default',
          content: cleanContent,
          replyToMessageId: body.replyToMessageId ?? null,
          forwardedFromMessageId: body.forwardedFromMessageId ?? null,
          forwardedFromChannelId,
          nonce: body.nonce ?? null,
        },
      });
      if (body.attachmentIds?.length) {
        await tx.attachment.updateMany({
          where: { id: { in: body.attachmentIds } },
          data: { messageId, channelId, serverId: result.serverId },
        });
      }
      // Phase 1.3: resolve and persist mention recipients inside the same
      // transaction so a failure rolls back the message itself.
      if (parsedMentions.length > 0 && result.serverId) {
        mentionRecipientIds = await resolveMentionRecipients({
          tx,
          parsed: parsedMentions,
          serverId: result.serverId,
          authorId: ctx.userId,
        });
        await writeMentionRecords({
          tx,
          recipients: mentionRecipientIds,
          messageId,
          channelId,
          dmChannelId: null,
        });
      }
      // Wave 3 #8 — forum channels: seed the sibling Thread row atomically
      // with the root message. Doing this OUTSIDE the transaction (the
      // previous arrangement) meant a transient DB error could leave the
      // forum view permanently broken for that post — the thread row is the
      // only thing the listing keys on.
      if (channelMeta?.type === 'forum' && !body.replyToMessageId) {
        const title = body.content.trim().split('\n')[0]?.slice(0, 120) || 'Untitled thread';
        await tx.thread.create({
          data: {
            id: ulid(),
            channelId,
            rootMessageId: messageId,
            title,
            createdBy: ctx.userId,
          },
        });
      }
      return tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
          poll: { select: { id: true } },
          replyTo: {
            select: {
              id: true,
              content: true,
              deletedAt: true,
              author: { select: { displayName: true } },
            },
          },
          forwardedFrom: {
            select: {
              id: true,
              channelId: true,
              author: { select: { displayName: true } },
            },
          },
        },
      });
    });

    const dto = serializeMessage(fullRow as MessageRow, ctx.userId);
    gatewayBroker.publish({
      type: 'MESSAGE_CREATE',
      serverId: result.serverId,
      channelId,
      data: dto,
    });
    // P3-6 — fan out the message to every peered instance with a member in
    // this server. Best-effort: local clients have already received the
    // broadcast above, federation delivery is async and must never block or
    // fail the HTTP response. Gated on:
    //   1. Deps (queues + selfHost) wired in — i.e. FEDERATION_ENABLED is on
    //   2. This is a server message (not a DM — DMs are Phase 5)
    //   3. Effective federation: combines server flag with channel override
    if (deps?.queues && deps.selfHost && result.serverId && channelMeta) {
      try {
        const server = await prisma.server.findUnique({
          where: { id: result.serverId },
          select: { federationEnabled: true },
        });
        const effective = computeEffectiveFederation(
          server?.federationEnabled ?? false,
          channelMeta.federationMode,
        );
        if (effective) {
          await fanOutMessageCreate({
            queues: deps.queues,
            selfHost: deps.selfHost,
            serverId: result.serverId,
            channelId,
            messageId: fullRow.id,
            authorUserId: fullRow.authorId,
            authorUsername: fullRow.author.username,
            content: fullRow.content,
            createdAt: fullRow.createdAt,
            replyToMessageId: fullRow.replyToMessageId,
            log: app.log,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.warn(
          { err: msg, messageId: fullRow.id, channelId, serverId: result.serverId },
          'federation fan-out failed for message.create',
        );
      }
    }
    // Wave 2 #4 — kick off OG link-preview generation. Fire-and-forget;
    // results flow back as LINK_PREVIEW_READY gateway events.
    enqueueLinkPreviews({
      messageId: fullRow.id,
      channelId,
      content: cleanContent,
    });

    // P2-9 — kick off best-effort remote profile lookups for any qualified
    // mentions (e.g. @alice@b.example) so the RemoteUser row is warm by the
    // time the web client renders the message. Fire-and-forget.
    resolveQualifiedMentionsAsync(cleanContent, deps?.federationProfile ?? null, app.log);

    // Phase 1.3: fan out MENTION_CREATE per recipient so each user's bell
    // updates without waiting for a full inbox refetch. The event payload
    // matches the inbox-store's InboxItem shape so the client can prepend.
    for (const r of mentionRecipientIds) {
      gatewayBroker.publish({
        type: 'MENTION_CREATE',
        userId: r.userId,
        data: {
          id: messageId,
          kind: r.kind,
          isRead: false,
          createdAt: fullRow.createdAt.toISOString(),
          channelId,
          dmChannelId: null,
          message: {
            id: fullRow.id,
            channelId: fullRow.channelId,
            dmChannelId: fullRow.dmChannelId,
            authorId: fullRow.authorId,
            authorDisplayName: fullRow.author.displayName,
            content: fullRow.content,
            createdAt: fullRow.createdAt.toISOString(),
          },
        },
      });
    }

    reply.status(201).send(ok(dto));
  });

  // Edit a message ---------------------------------------------------------
  app.patch('/api/messages/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateMessageRequestSchema.parse(req.body);

    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        authorId: true,
        channelId: true,
        dmChannelId: true,
        serverId: true,
        deletedAt: true,
      },
    });
    if (!message || message.deletedAt) throw TavernError.notFound('Message not found');
    if (message.authorId !== ctx.userId) throw TavernError.forbidden('Only the author can edit a message');

    const cleanContent = sanitizeContent(body.content);
    // SEC: re-run the mention permission gates on edit. Without this, a user
    // can post a benign message, then edit it to add @everyone / a non-
    // mentionable role and bypass the same checks the create route enforces.
    if (message.serverId && message.channelId) {
      const parsedMentions = parseMentions(cleanContent);
      const editPerms = await getChannelPermissions(message.channelId, ctx.userId);
      if (!editPerms) throw TavernError.notFound('Message not found');
      const editIsAdmin = hasFlag(editPerms.perms, Permission.ADMINISTRATOR);
      const canMentionEveryone =
        editIsAdmin || hasFlag(editPerms.perms, Permission.MENTION_EVERYONE);
      if (hasGroupMention(parsedMentions) && !canMentionEveryone) {
        throw TavernError.forbidden('You cannot use @everyone or @here in this room');
      }
      const candidateRoleNames = nameMentions(parsedMentions);
      if (candidateRoleNames.length > 0 && !canMentionEveryone) {
        const nonMentionableRoles = await prisma.role.findMany({
          where: {
            serverId: message.serverId,
            name: { in: candidateRoleNames },
            mentionable: false,
          },
          select: { name: true },
        });
        if (nonMentionableRoles.length > 0) {
          throw TavernError.forbidden(
            `Role @${nonMentionableRoles[0]?.name} is not mentionable here`,
          );
        }
      }
    }
    // Wave 2 #10 — append previous content to edit history *before* the
    // mutation so we never lose a revision (rolls back if the update fails).
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.message.findUniqueOrThrow({
        where: { id },
        select: { content: true },
      });
      if (existing.content !== cleanContent) {
        await tx.messageEdit.create({
          data: {
            id: ulid(),
            messageId: id,
            content: existing.content,
            editedBy: ctx.userId,
          },
        });
      }
      return tx.message.update({
        where: { id },
        data: { content: cleanContent, editedAt: new Date() },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
          poll: { select: { id: true } },
          replyTo: {
            select: {
              id: true,
              content: true,
              deletedAt: true,
              author: { select: { displayName: true } },
            },
          },
          forwardedFrom: {
            select: {
              id: true,
              channelId: true,
              author: { select: { displayName: true } },
            },
          },
        },
      });
    });
    const dto = serializeMessage(updated as MessageRow, ctx.userId);
    if (message.dmChannelId) {
      gatewayBroker.publish({
        type: 'DM_MESSAGE_UPDATE',
        dmChannelId: message.dmChannelId,
        data: dto,
      });
    } else {
      gatewayBroker.publish({
        type: 'MESSAGE_UPDATE',
        serverId: message.serverId ?? undefined,
        channelId: message.channelId ?? undefined,
        data: dto,
      });
    }
    reply.send(ok(dto));
  });

  // Delete a message -------------------------------------------------------
  app.delete('/api/messages/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        authorId: true,
        channelId: true,
        dmChannelId: true,
        serverId: true,
        deletedAt: true,
      },
    });
    if (!message || message.deletedAt) throw TavernError.notFound('Message not found');

    if (message.authorId !== ctx.userId) {
      // For server messages, MANAGE_MESSAGES on the channel allows deleting
      // others' content. DM messages have no admin override — only the
      // author can delete their own posts.
      if (message.dmChannelId) {
        throw TavernError.forbidden();
      }
      if (!message.channelId) throw TavernError.notFound('Message not found');
      const result = await getChannelPermissions(message.channelId, ctx.userId);
      if (!result) throw TavernError.notFound('Message not found');
      if (
        (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR &&
        (result.perms & Permission.MANAGE_MESSAGES) !== Permission.MANAGE_MESSAGES
      ) {
        throw TavernError.forbidden();
      }
    }

    const deletedAt = new Date();
    // Soft-delete tombstones the message but does NOT cascade — the schema's
    // ON DELETE CASCADE only fires on hard-delete. Without explicit cleanup
    // the pinned-message list keeps the (now empty) row, the mention bell
    // keeps the unread highlight, and reactions accumulate against content
    // nobody can see. Wrap in a transaction so a partial cleanup either
    // commits fully or rolls back the deletedAt write.
    await prisma.$transaction(async (tx) => {
      await tx.message.update({
        where: { id },
        data: { deletedAt, content: '' },
      });
      await tx.messageReaction.deleteMany({ where: { messageId: id } });
      await tx.userMention.deleteMany({ where: { messageId: id } });
      await tx.pinnedMessage.deleteMany({ where: { messageId: id } });
    });
    if (message.authorId !== ctx.userId && message.serverId) {
      await writeAuditEntry({
        serverId: message.serverId,
        actorId: ctx.userId,
        action: 'message.deleted',
        targetType: 'message',
        targetId: id,
      });
    }
    if (message.dmChannelId) {
      gatewayBroker.publish({
        type: 'DM_MESSAGE_DELETE',
        dmChannelId: message.dmChannelId,
        data: { id, dmChannelId: message.dmChannelId, deletedAt: deletedAt.toISOString() },
      });
    } else {
      gatewayBroker.publish({
        type: 'MESSAGE_DELETE',
        serverId: message.serverId ?? undefined,
        channelId: message.channelId ?? undefined,
        data: { id, channelId: message.channelId, deletedAt: deletedAt.toISOString() },
      });
    }
    reply.send(ok({ id }));
  });
}
