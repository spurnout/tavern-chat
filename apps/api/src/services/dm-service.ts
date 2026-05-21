/**
 * Direct-message service.
 *
 * The whole DM permission model is "are you a member of this DmChannel?".
 * Starting a DM additionally requires the participants to share at least
 * one server — Tavern is a small-community app, not a public chat, so
 * arbitrary strangers can't DM you.
 */

import { Prisma, prisma } from '@tavern/db';
import { TavernError, ulid, type DmChannel as DmChannelDto } from '@tavern/shared';

/**
 * Deterministic identity for a 1:1 DM pair. Sorting the two userIds means
 * `directPairKey(a, b) === directPairKey(b, a)` so concurrent starts from
 * either side hit the same UNIQUE row.
 */
export function directPairKey(userA: string, userB: string): string {
  return userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;
}

/**
 * Federation-aware variant of `directPairKey` for 1:1 DMs that span
 * instances. Inputs are qualified ids of the form `<localpart>@<host>`:
 *
 *   - Local side:  `${user.username}@${selfHost}`
 *   - Remote side: `user.remoteUserId` (already qualified)
 *
 * Sorting is plain lexicographic, identical to `directPairKey` — the only
 * difference is the input alphabet. We deliberately keep this as a separate
 * helper (instead of overloading `directPairKey`) so the call site documents
 * which form of identity it's using and so a misuse (e.g. mixing a local id
 * with a qualified id) is loud rather than silent.
 */
export function federatedDmPairKey(
  qualifiedIdA: string,
  qualifiedIdB: string,
): string {
  return qualifiedIdA < qualifiedIdB
    ? `${qualifiedIdA}:${qualifiedIdB}`
    : `${qualifiedIdB}:${qualifiedIdA}`;
}

/**
 * Return the dmChannel row if the user is a member; throw 404 / 403
 * otherwise. Throwing 404 instead of 403 on non-membership avoids leaking
 * which DM channels exist.
 */
export async function requireDmChannelMembership(
  dmChannelId: string,
  userId: string,
): Promise<{
  id: string;
  kind: 'direct' | 'group';
  name: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
}> {
  const channel = await prisma.dmChannel.findUnique({
    where: { id: dmChannelId },
    select: {
      id: true,
      kind: true,
      name: true,
      createdAt: true,
      lastMessageAt: true,
      members: { where: { userId }, select: { userId: true } },
    },
  });
  if (!channel || channel.members.length === 0) {
    throw TavernError.notFound('DM not found');
  }
  return {
    id: channel.id,
    kind: channel.kind,
    name: channel.name,
    createdAt: channel.createdAt,
    lastMessageAt: channel.lastMessageAt,
  };
}

/**
 * True if userA and userB are both members of at least one server. Used
 * as the gate when starting a DM with someone.
 *
 * Federation note: this query works unchanged for federated mirror members
 * because remote users live as `User` rows (with `remoteUserId` set) and
 * are recorded in `ServerMember` exactly like local users. Both ids are
 * always local User ids — the caller resolves remote identities to mirror
 * User rows upstream.
 */
export async function usersShareServer(userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return false;
  const shared = await prisma.serverMember.findFirst({
    where: {
      userId: userA,
      server: {
        members: { some: { userId: userB } },
      },
    },
    select: { serverId: true },
  });
  return shared !== null;
}

/**
 * Look up the 1:1 DM channel between A and B if one exists; create one
 * otherwise. Idempotent — calling twice returns the same channel.
 *
 * Concurrency: `(kind = 'direct', pairKey)` is enforced UNIQUE in the
 * database, so a race between two simultaneous starts surfaces as a
 * P2002 unique-constraint violation that we recover from by fetching
 * whichever side won.
 *
 * Federation: when the OTHER user is a remote-user mirror (User row with
 * `remoteUserId IS NOT NULL`) AND `opts.selfHost` is provided, the pairKey
 * is computed from qualified ids (`<creator.username>@<selfHost>` +
 * `other.remoteUserId`) instead of local User ids. This makes the pairKey
 * stable across both ends of the federation hop — the remote instance
 * computes the same key from its side using the mirrored pair of usernames.
 *
 * Caveat: if the operator renames the instance (PUBLIC_BASE_URL host
 * changes), previously-created federated DM rows are orphaned because the
 * recomputed pairKey no longer matches. A subsequent open call will create
 * a new DmChannel with the new key. Hostname changes are an identity event
 * and should be handled with the same care as user-rename — see
 * `docs/federation.md`.
 */
export interface FindOrCreateDirectDmOpts {
  /**
   * Local instance's federation host (e.g. `a.example`). Required to build
   * the qualified-id pairKey for federated DMs. Pass `null`/`undefined` on
   * non-federated instances; the local-id pairKey is used in that case.
   */
  selfHost?: string | null;
}

export async function findOrCreateDirectDm(
  creatorId: string,
  otherUserId: string,
  opts?: FindOrCreateDirectDmOpts,
): Promise<string> {
  if (creatorId === otherUserId) {
    throw TavernError.validation('Cannot DM yourself');
  }

  // Load both users in a single round-trip; we need usernames + remoteUserId
  // to decide whether this is a federated DM (other side is a mirror user).
  const users = await prisma.user.findMany({
    where: { id: { in: [creatorId, otherUserId] } },
    select: { id: true, username: true, remoteUserId: true },
  });
  const creator = users.find((u) => u.id === creatorId);
  const otherUser = users.find((u) => u.id === otherUserId);
  if (!creator || !otherUser) {
    throw TavernError.notFound('User not found');
  }

  const selfHost = opts?.selfHost ?? null;
  // Federation gate: switch to qualified-id pairKey only when the other
  // side is a mirror AND we know our own host. Both local users + missing
  // selfHost fall through to the legacy local-id pairKey.
  const pairKey =
    otherUser.remoteUserId !== null && selfHost
      ? federatedDmPairKey(`${creator.username}@${selfHost}`, otherUser.remoteUserId)
      : directPairKey(creatorId, otherUserId);

  const existing = await prisma.dmChannel.findUnique({
    where: { pairKey },
    select: { id: true },
  });
  if (existing) return existing.id;

  const channelId = ulid();
  try {
    await prisma.dmChannel.create({
      data: {
        id: channelId,
        kind: 'direct',
        pairKey,
        createdById: creatorId,
        members: {
          create: [{ userId: creatorId }, { userId: otherUserId }],
        },
      },
    });
    return channelId;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.dmChannel.findUnique({
        where: { pairKey },
        select: { id: true },
      });
      if (winner) return winner.id;
    }
    throw err;
  }
}

/**
 * Create a new group DM. `memberUserIds` are the other participants; the
 * creator is added automatically. Tavern caps groups at 10 members
 * (creator + 9 invitees) — anything larger is a server, not a DM.
 */
export async function createGroupDm(
  creatorId: string,
  memberUserIds: string[],
  name: string | null,
): Promise<string> {
  // Deduplicate and exclude the creator if they snuck into the list.
  const others = Array.from(new Set(memberUserIds)).filter((u) => u !== creatorId);
  if (others.length < 2) {
    throw TavernError.validation('Group DM needs at least 2 other members');
  }
  if (others.length > 9) {
    throw TavernError.validation('Group DM is limited to 10 members total');
  }
  const channelId = ulid();
  await prisma.dmChannel.create({
    data: {
      id: channelId,
      kind: 'group',
      name,
      createdById: creatorId,
      members: {
        create: [creatorId, ...others].map((userId) => ({ userId })),
      },
    },
  });
  return channelId;
}

/** Prisma `include` literal used by both single-row and list serializers. */
export const dmChannelWithMembersInclude = {
  members: {
    include: {
      user: { select: { id: true, displayName: true, username: true, presence: true } },
    },
  },
} as const;

type DmChannelWithMembers = {
  id: string;
  kind: 'direct' | 'group';
  name: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  members: Array<{
    userId: string;
    joinedAt: Date;
    lastReadAt: Date | null;
    user: { id: string; displayName: string; username: string; presence: string };
  }>;
};

/**
 * Pure serializer over an already-loaded DmChannel row. Use this from the
 * DM list endpoint to avoid one extra `findUnique` per channel.
 */
export function serializeDmChannelRow(
  row: DmChannelWithMembers,
  callerId: string,
): DmChannelDto {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    members: row.members.map((m) => ({
      userId: m.userId,
      user: {
        id: m.user.id,
        displayName: m.user.displayName,
        username: m.user.username,
        presence: m.user.presence as DmChannelDto['members'][number]['user']['presence'],
      },
      joinedAt: m.joinedAt.toISOString(),
      lastReadAt: m.userId === callerId && m.lastReadAt ? m.lastReadAt.toISOString() : null,
    })),
  };
}

/**
 * Wire-shape DTO for the API; includes member user info + the calling
 * user's lastReadAt watermark. Convenience wrapper that loads the row.
 */
export async function serializeDmChannel(
  dmChannelId: string,
  callerId: string,
): Promise<DmChannelDto> {
  const channel = await prisma.dmChannel.findUnique({
    where: { id: dmChannelId },
    include: dmChannelWithMembersInclude,
  });
  if (!channel) throw TavernError.notFound('DM not found');
  return serializeDmChannelRow(channel as unknown as DmChannelWithMembers, callerId);
}
