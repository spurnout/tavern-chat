/**
 * Federation Phase 6 — presence fan-out target query (P6-5).
 *
 * `findPresenceFanOutPeers(prisma, userId)` returns the set of peered
 * `RemoteInstance`s that should receive a `presence.update` envelope for the
 * given LOCAL user. A peer qualifies iff one or both of:
 *
 *   (a) it has at least one `ServerMember` row in a `Server` where
 *       `federationEnabled = true` AND the input user is also a member of
 *       that server; OR
 *   (b) it owns the OTHER member of a `DmChannel` that contains the input
 *       user (i.e. the user shares a federated 1:1 / group DM with that
 *       peer's home).
 *
 * In both branches the peer's `RemoteInstance.status` must be `'peered'`.
 *
 * Authority note: this helper does NOT check whether the input user is itself
 * a remote-user mirror. The caller (P6-6 outbound fan-out from
 * `presence-service.ts`) decides to skip fan-out when
 * `User.remoteInstanceId !== null` — a remote mirror's presence is
 * authoritatively emitted by its home, not by us. This helper just answers
 * "which peers share a federated surface with this user", which is identical
 * for local and mirror users.
 *
 * Implementation: two `findMany` queries (one per surface — Taverns vs DMs)
 * are unioned in TypeScript and deduplicated by `peerInstanceId`. The plan
 * (P6-5) prescribes this over a single combined query because Prisma's ORM
 * does not have a portable UNION primitive, and at V1 traffic levels the
 * extra round-trip is negligible. Each query already targets indexed columns
 * (`ServerMember.userId`, `DmChannelMember.userId`,
 * `RemoteInstance.status`).
 */

import type { PrismaClient } from '@prisma/client';

export interface PresenceFanOutPeer {
  peerInstanceId: string;
  host: string;
}

export async function findPresenceFanOutPeers(
  prisma: PrismaClient,
  userId: string,
): Promise<PresenceFanOutPeer[]> {
  // Query A — peers via federated Taverns.
  //
  // Find every Server that:
  //   - has federationEnabled = true, AND
  //   - has the input user as a member (server.members.some.userId = userId),
  // then collect distinct peered RemoteInstances that ALSO have at least one
  // member in those servers.
  const tavernRows = await prisma.serverMember.findMany({
    where: {
      // Peer-side: the joined ServerMember belongs to a user whose home is a
      // peered RemoteInstance.
      user: {
        remoteInstanceId: { not: null },
        remoteInstance: { status: 'peered' },
      },
      // Same-server gate: this peer-side ServerMember row sits in a Server
      // that (a) is federationEnabled AND (b) has the input user as a
      // member.
      server: {
        federationEnabled: true,
        members: { some: { userId } },
      },
    },
    select: {
      user: {
        select: {
          remoteInstanceId: true,
          remoteInstance: { select: { id: true, host: true } },
        },
      },
    },
  });

  // Query B — peers via federated DMs.
  //
  // Find every DmChannelMember row whose user is a remote mirror on a peered
  // RemoteInstance AND whose DmChannel also contains the input user. The
  // input user is implicitly excluded from the peer set because their
  // remoteInstanceId is null.
  const dmRows = await prisma.dmChannelMember.findMany({
    where: {
      user: {
        remoteInstanceId: { not: null },
        remoteInstance: { status: 'peered' },
      },
      channel: {
        members: { some: { userId } },
      },
    },
    select: {
      user: {
        select: {
          remoteInstanceId: true,
          remoteInstance: { select: { id: true, host: true } },
        },
      },
    },
  });

  // Union + dedupe by peerInstanceId. We preserve insertion order so callers
  // get a stable iteration (Taverns first, then DMs not already covered).
  const seen = new Set<string>();
  const out: PresenceFanOutPeer[] = [];
  const consume = (row: { user: { remoteInstanceId: string | null; remoteInstance: { id: string; host: string } | null } }): void => {
    const ri = row.user.remoteInstance;
    if (!ri) return;
    if (seen.has(ri.id)) return;
    seen.add(ri.id);
    out.push({ peerInstanceId: ri.id, host: ri.host });
  };
  for (const r of tavernRows) consume(r);
  for (const r of dmRows) consume(r);
  return out;
}
