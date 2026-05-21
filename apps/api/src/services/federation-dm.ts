/**
 * Shared DM federation helpers.
 *
 * Extracted from `routes/messages.ts` in P5-9 so the reaction routes can
 * use the same DM peer-resolution logic without re-implementing or
 * importing across route modules. The helper itself is unchanged from its
 * P5-7 origin — see the inline comment for the gating story.
 */

import { prisma } from '@tavern/db';

/**
 * P5-7 — shared DM-side lookup for the PATCH / DELETE / reaction federation
 * branches.
 *
 * Returns the OTHER member's `remoteInstanceId` (when set — i.e. the DM is
 * federated) for a 1:1 DM. Returns null for:
 *   - missing channel (defensive — the route already verified the message
 *     exists, but the DmChannel could in principle have been deleted by a
 *     concurrent action),
 *   - group DMs (`kind !== 'direct'`) — Phase 5 only federates 1:1,
 *   - both members local (`other.remoteInstanceId == null`),
 *   - malformed membership (no "other" member, which is a 1:1 invariant
 *     violation — bail rather than throw on a degenerate row).
 *
 * One extra `findUnique` per DM PATCH/DELETE/reaction on a federated path.
 * The call sites each wrap this in their own try/catch so a lookup failure
 * logs + skips the fan-out without breaking the local mutation that
 * already committed.
 */
export async function resolveDmFanOutTarget(
  dmChannelId: string,
  selfUserId: string,
): Promise<{ peerInstanceId: string } | null> {
  const channel = await prisma.dmChannel.findUnique({
    where: { id: dmChannelId },
    select: {
      kind: true,
      members: {
        select: {
          userId: true,
          user: { select: { id: true, remoteInstanceId: true } },
        },
      },
    },
  });
  if (!channel || channel.kind !== 'direct') return null;
  const other = channel.members.find((m) => m.userId !== selfUserId);
  if (!other || !other.user.remoteInstanceId) return null;
  return { peerInstanceId: other.user.remoteInstanceId };
}
