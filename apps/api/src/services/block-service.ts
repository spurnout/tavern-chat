/**
 * Member-block service.
 *
 * A block is a one-directional, private relationship: `blockerId` has blocked
 * `blockedId`. Effects are enforced server-side at two seams — the DM-open
 * path (refuse in either direction) and the mention resolver (suppress
 * notifications from a blocked author) — and client-side for message/reaction
 * hiding in shared rooms (channel fan-out stays symmetric so the blocked
 * member never learns they were blocked).
 *
 * This module centralizes the lookups so routes, the DM service, and the
 * mention service share one implementation (mirrors how `dm-service.ts`
 * exposes `usersShareServer`).
 */

import { prisma } from '@tavern/db';
import type { BlockedUser } from '@tavern/shared';

/** True if `blockerId` has blocked `blockedId` (directional). */
export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const row = await prisma.userBlock.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    select: { blockerId: true },
  });
  return row !== null;
}

/**
 * Check both directions of a pair in a single query. Used by the DM-open gate:
 * if either side has blocked the other, the DM is refused.
 */
export async function blockExistsEitherDirection(
  a: string,
  b: string,
): Promise<{ aBlocksB: boolean; bBlocksA: boolean }> {
  if (a === b) return { aBlocksB: false, bBlocksA: false };
  const rows = await prisma.userBlock.findMany({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });
  return {
    aBlocksB: rows.some((r) => r.blockerId === a && r.blockedId === b),
    bBlocksA: rows.some((r) => r.blockerId === b && r.blockedId === a),
  };
}

/**
 * Of `candidateIds`, return the subset that have blocked `authorId`. Used by
 * the mention resolver to drop notifications from a blocked author in one
 * batched query.
 */
export async function blockersOf(
  authorId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await prisma.userBlock.findMany({
    where: { blockedId: authorId, blockerId: { in: candidateIds } },
    select: { blockerId: true },
  });
  return new Set(rows.map((r) => r.blockerId));
}

/** Ids this user has blocked. */
export async function getBlockedIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    select: { blockedId: true },
  });
  return new Set(rows.map((r) => r.blockedId));
}

/** The blocker's list, serialized for the settings UI / gateway payload. */
export async function listBlocks(userId: string): Promise<BlockedUser[]> {
  const rows = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    orderBy: { createdAt: 'desc' },
    select: {
      blockedId: true,
      createdAt: true,
      blocked: { select: { id: true, displayName: true, username: true } },
    },
  });
  return rows.map((r) => ({
    userId: r.blockedId,
    user: {
      id: r.blocked.id,
      displayName: r.blocked.displayName,
      username: r.blocked.username,
    },
    createdAt: r.createdAt.toISOString(),
  }));
}
