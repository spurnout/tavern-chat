import { Prisma, prisma } from '@tavern/db';
import { ulid } from '@tavern/shared';
import { gatewayBroker } from './gateway-broker.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';

export interface AuditWriteInput {
  serverId?: string | null | undefined;
  actorId?: string | null | undefined;
  action: string;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export async function writeAuditEntry(input: AuditWriteInput): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      id: ulid(),
      serverId: input.serverId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata:
        input.metadata !== undefined ? (input.metadata as Prisma.InputJsonValue) : undefined,
    },
  });
  // Wave 3 #18 — mod-log channel mirror. When the server configured a
  // modLogChannelId, post a system message there. Fire-and-forget so an
  // outage on the mirror never blocks the underlying action.
  if (input.serverId) {
    void postModLogMirror(input).catch(() => undefined);
  }
}

async function postModLogMirror(input: AuditWriteInput): Promise<void> {
  if (!input.serverId) return;
  const server = await prisma.server.findUnique({
    where: { id: input.serverId },
    select: { modLogChannelId: true, ownerUserId: true },
  });
  if (!server?.modLogChannelId) return;

  const actor = input.actorId
    ? await prisma.user.findUnique({
        where: { id: input.actorId },
        select: { displayName: true, username: true },
      })
    : null;
  const actorName = actor?.displayName ?? '(system)';

  const summary = formatAction(input.action);
  const targetSuffix = input.targetType && input.targetId ? ` · ${input.targetType}:${input.targetId}` : '';
  const reason =
    input.metadata && typeof input.metadata === 'object' && 'reason' in input.metadata
      ? ` — ${String((input.metadata as { reason?: unknown }).reason ?? '')}`
      : '';
  const content = `**${actorName}** ${summary}${targetSuffix}${reason}`;

  const messageId = ulid();
  const row = await prisma.message.create({
    data: {
      id: messageId,
      serverId: input.serverId,
      channelId: server.modLogChannelId,
      // Audit entries are mirrored under the server-owner author for visual
      // attribution; the actor name is in the content.
      authorId: server.ownerUserId,
      type: 'system',
      content,
    },
    include: {
      attachments: { select: { id: true } },
      reactions: { select: { emoji: true, userId: true } },
      author: { select: { id: true, displayName: true, username: true } },
      poll: { select: { id: true } },
    },
  });
  gatewayBroker.publish({
    type: 'MESSAGE_CREATE',
    serverId: input.serverId,
    channelId: server.modLogChannelId,
    data: serializeMessage(row as MessageRow, server.ownerUserId),
  });
}

function formatAction(action: string): string {
  switch (action) {
    case 'member.timeout':
      return 'timed out a member';
    case 'member.timeout_clear':
      return 'lifted a timeout';
    case 'member.kick':
      return 'kicked a member';
    case 'member.warn':
      return 'warned a member';
    case 'message.deleted':
      return 'deleted a message';
    case 'message.bulk_delete':
      return 'bulk-deleted messages';
    case 'channel.updated':
      return 'updated a room';
    case 'automod.hit':
      return 'auto-moderation triggered';
    default:
      return `did **${action}**`;
  }
}
