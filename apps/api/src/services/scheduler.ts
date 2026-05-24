import { prisma } from '@tavern/db';
import { ulid } from '@tavern/shared';
import sanitizeHtml from 'sanitize-html';
import { gatewayBroker } from './gateway-broker.js';
import {
  serializeMessage,
  type MessageRow,
} from '../lib/serializers.js';

/**
 * Scheduled dispatch — minimal in-process scheduler.
 *
 * For single-replica deployments (the default), pending dispatches are held
 * as Node setTimeout entries keyed by id. On process restart, recover() is
 * called once at API startup to re-arm any pending rows whose dispatchAt is
 * within the next 24 hours; anything further out gets picked up by the next
 * boot (operators running daily reboots will lose nothing; long-running
 * deployments depend on the recovery sweep).
 *
 * Multi-replica deployments should swap this for a BullMQ delayed job in the
 * worker — the routes themselves are agnostic.
 */

const timers = new Map<string, NodeJS.Timeout>();

function sanitize(s: string): string {
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} });
}

async function dispatchOnce(dispatchId: string): Promise<void> {
  const row = await prisma.scheduledDispatch.findUnique({ where: { id: dispatchId } });
  if (!row) return;
  if (row.status !== 'pending') return;

  try {
    if (row.kind === 'message') {
      const payload = row.payload as { content: string; attachmentIds?: string[] };
      if (!row.channelId) throw new Error('channelId required for scheduled message');
      const channel = await prisma.channel.findUnique({
        where: { id: row.channelId },
        select: { serverId: true },
      });
      if (!channel) throw new Error('channel not found');

      const messageId = ulid();
      const full = await prisma.message.create({
        data: {
          id: messageId,
          serverId: channel.serverId,
          channelId: row.channelId,
          authorId: row.userId,
          type: 'default',
          content: sanitize(payload.content ?? ''),
        },
        include: {
          attachments: { select: { id: true } },
          reactions: { select: { emoji: true, userId: true } },
          author: { select: { id: true, displayName: true, username: true } },
          poll: { select: { id: true } },
        },
      });

      await prisma.scheduledDispatch.update({
        where: { id: dispatchId },
        data: { status: 'sent', sentMessageId: messageId },
      });

      gatewayBroker.publish({
        type: 'MESSAGE_CREATE',
        serverId: channel.serverId,
        channelId: row.channelId,
        data: serializeMessage(full as MessageRow, row.userId),
      });
    } else if (row.kind === 'reminder') {
      // Reminders surface as a user-scoped MENTION_CREATE-style notification.
      // The client's inbox-store already knows how to render it.
      const payload = row.payload as { text: string };
      await prisma.scheduledDispatch.update({
        where: { id: dispatchId },
        data: { status: 'sent' },
      });
      gatewayBroker.publish({
        type: 'MENTION_CREATE',
        userId: row.userId,
        data: {
          id: dispatchId,
          kind: 'user',
          isRead: false,
          createdAt: new Date().toISOString(),
          channelId: null,
          dmChannelId: null,
          message: {
            id: dispatchId,
            channelId: null,
            dmChannelId: null,
            authorId: row.userId,
            authorDisplayName: 'Reminder',
            type: 'system',
            content: sanitize(payload.text ?? ''),
            diceRoll: null,
            createdAt: new Date().toISOString(),
          },
        },
      });
    }
  } catch (err) {
    await prisma.scheduledDispatch.update({
      where: { id: dispatchId },
      data: {
        status: 'failed',
        failureReason: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function scheduleDispatch(id: string, dispatchAt: Date): void {
  cancelDispatch(id);
  const delay = Math.max(0, dispatchAt.getTime() - Date.now());
  const MAX_DELAY = 2_147_483_647; // setTimeout's 32-bit signed max.
  if (delay > MAX_DELAY) {
    // Too far out for a single timer — let the next process restart pick it up
    // via recoverScheduledDispatches.
    return;
  }
  const t = setTimeout(() => {
    timers.delete(id);
    void dispatchOnce(id);
  }, delay);
  timers.set(id, t);
}

export function cancelDispatch(id: string): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/**
 * Called once at API startup to re-arm pending dispatches that are due in
 * the next 24h. Anything further out is picked up at the next process boot.
 */
export async function recoverScheduledDispatches(): Promise<void> {
  const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pending = await prisma.scheduledDispatch.findMany({
    where: {
      status: 'pending',
      dispatchAt: { lte: horizon },
    },
    select: { id: true, dispatchAt: true },
  });
  for (const p of pending) {
    scheduleDispatch(p.id, p.dispatchAt);
  }
}
