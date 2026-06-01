/**
 * Post a `type='system'` message into a server channel and broadcast it.
 *
 * Factored from the mod-log mirror in `audit-service.ts` so onboarding /
 * join flows can drop "X joined the tavern" notices into a configured system
 * room. Attribution follows the same convention as the mod-log mirror: the
 * message is authored by the server owner for visual attribution, with the
 * human-readable subject baked into the content.
 *
 * Fire-and-forget by contract — callers wrap with `.catch(() => undefined)`
 * so a system-room outage never breaks the underlying join.
 */

import { prisma } from '@tavern/db';
import { ulid } from '@tavern/shared';
import { gatewayBroker } from './gateway-broker.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';

export async function postSystemMessage(
  serverId: string,
  channelId: string,
  content: string,
): Promise<void> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerUserId: true },
  });
  if (!server) return;

  const row = await prisma.message.create({
    data: {
      id: ulid(),
      serverId,
      channelId,
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
    serverId,
    channelId,
    data: serializeMessage(row as MessageRow, server.ownerUserId),
  });
}
