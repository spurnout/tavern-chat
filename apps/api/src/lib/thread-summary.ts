/**
 * Batch loader for the per-message thread footer payload.
 *
 * Used by the channel-messages list endpoint and the message-edit path to
 * decorate thread-root rows with `{ threadId, replyCount, lastActivityAt }`
 * before serialization, so the chat view can render a clickable "N replies
 * — last reply Xm ago" footer without a second round-trip per message.
 *
 * Two queries regardless of page size:
 *   1. Threads keyed by rootMessageId.
 *   2. Grouped count of non-deleted messages per threadId.
 */

import { prisma } from '@tavern/db';

export interface ThreadSummary {
  threadId: string;
  replyCount: number;
  lastActivityAt: Date;
}

export async function loadThreadSummariesForRootIds(
  rootMessageIds: readonly string[],
): Promise<Map<string, ThreadSummary>> {
  const summaries = new Map<string, ThreadSummary>();
  if (rootMessageIds.length === 0) return summaries;

  const threads = await prisma.thread.findMany({
    where: { rootMessageId: { in: [...rootMessageIds] } },
    select: { id: true, rootMessageId: true, lastActivityAt: true },
  });
  if (threads.length === 0) return summaries;

  const threadIds = threads.map((t) => t.id);
  const replyCountRows = await prisma.message.groupBy({
    by: ['threadId'],
    where: { threadId: { in: threadIds }, deletedAt: null },
    _count: { _all: true },
  });
  const countsByThreadId = new Map<string, number>();
  for (const row of replyCountRows) {
    if (row.threadId) countsByThreadId.set(row.threadId, row._count._all);
  }

  for (const t of threads) {
    summaries.set(t.rootMessageId, {
      threadId: t.id,
      replyCount: countsByThreadId.get(t.id) ?? 0,
      lastActivityAt: t.lastActivityAt,
    });
  }
  return summaries;
}

export async function loadThreadSummaryForRootId(
  rootMessageId: string,
): Promise<ThreadSummary | null> {
  const map = await loadThreadSummariesForRootIds([rootMessageId]);
  return map.get(rootMessageId) ?? null;
}
