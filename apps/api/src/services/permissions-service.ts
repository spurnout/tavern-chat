import { Prisma, prisma } from '@tavern/db';
import {
  ErrorCodes,
  Permission,
  PERMISSION_ALL,
  PERMISSION_NONE,
  TavernError,
  computeBasePermissions,
  computeChannelPermissions,
  parsePermissions,
  type ResolvedOverwrite,
} from '@tavern/shared';

interface MemberInfo {
  isOwner: boolean;
  everyonePerms: bigint;
  rolePerms: bigint[];
  roleIds: string[];
  /** The server's @everyone role id, surfaced so callers don't re-query. */
  everyoneRoleId: string | null;
}

/**
 * Resolve a member's permission context for a server.
 *
 * Performance: this is the single hottest DB call in the API. It used to
 * issue 3 serial Prisma round-trips (server → memberRoles → everyoneRole);
 * those are now collapsed into one `findUnique` with nested includes
 * (DB-001 + DB-006). Server membership also drives gateway fanout, so this
 * runs hundreds of times per realtime event burst.
 */
async function loadMemberContext(serverId: string, userId: string): Promise<MemberInfo | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: {
      ownerUserId: true,
      defaultRoleId: true,
      defaultRole: { select: { permissions: true } },
      members: {
        where: { userId },
        select: {
          roles: {
            select: {
              role: { select: { id: true, permissions: true } },
            },
          },
        },
      },
    },
  });
  if (!server) return null;

  const isOwner = server.ownerUserId === userId;
  const member = server.members[0];
  if (!member && !isOwner) return null;

  const everyonePerms = server.defaultRole
    ? parsePermissions(server.defaultRole.permissions.toString())
    : PERMISSION_NONE;

  const memberRoles = member?.roles ?? [];
  const rolePerms = memberRoles.map((r) => parsePermissions(r.role.permissions.toString()));
  const roleIds = memberRoles.map((r) => r.role.id);

  return {
    isOwner,
    everyonePerms,
    rolePerms,
    roleIds,
    everyoneRoleId: server.defaultRoleId,
  };
}

export async function getServerPermissions(serverId: string, userId: string): Promise<bigint> {
  const ctx = await loadMemberContext(serverId, userId);
  if (!ctx) return PERMISSION_NONE;
  return computeBasePermissions({
    isOwner: ctx.isOwner,
    everyoneRolePermissions: ctx.everyonePerms,
    rolePermissions: ctx.rolePerms,
  });
}

export async function getChannelPermissions(
  channelId: string,
  userId: string,
): Promise<{ perms: bigint; serverId: string } | null> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, serverId: true },
  });
  if (!channel) return null;

  const ctx = await loadMemberContext(channel.serverId, userId);
  if (!ctx) return { perms: PERMISSION_NONE, serverId: channel.serverId };
  if (ctx.isOwner) return { perms: PERMISSION_ALL, serverId: channel.serverId };

  const overwrites = await prisma.permissionOverwrite.findMany({
    where: { channelId },
  });

  // DB-006: the @everyone role id is already on the member context — don't
  // re-query the Server row for it.
  const everyoneRoleId = ctx.everyoneRoleId;

  let everyoneOverwrite: ResolvedOverwrite | undefined;
  let userOverwrite: ResolvedOverwrite | undefined;
  const roleOverwrites: ResolvedOverwrite[] = [];

  for (const o of overwrites) {
    const allow = parsePermissions(o.allow.toString());
    const deny = parsePermissions(o.deny.toString());
    if (o.targetType === 'role') {
      if (o.targetId === everyoneRoleId) {
        everyoneOverwrite = { allow, deny };
      } else if (ctx.roleIds.includes(o.targetId)) {
        roleOverwrites.push({ allow, deny });
      }
    } else if (o.targetType === 'user' && o.targetId === userId) {
      userOverwrite = { allow, deny };
    }
  }

  const perms = computeChannelPermissions({
    isOwner: false,
    everyoneRolePermissions: ctx.everyonePerms,
    rolePermissions: ctx.rolePerms,
    everyoneChannelOverwrite: everyoneOverwrite,
    roleChannelOverwrites: roleOverwrites,
    userChannelOverwrite: userOverwrite,
  });
  return { perms, serverId: channel.serverId };
}

export async function requireServerPermission(
  serverId: string,
  userId: string,
  flag: bigint,
): Promise<bigint> {
  const perms = await getServerPermissions(serverId, userId);
  if ((perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return perms;
  if ((perms & flag) !== flag) throw TavernError.forbidden();
  return perms;
}

export async function requireChannelPermission(
  channelId: string,
  userId: string,
  flag: bigint,
): Promise<{ perms: bigint; serverId: string }> {
  const result = await getChannelPermissions(channelId, userId);
  if (!result) throw TavernError.notFound('Channel not found');
  if (
    (result.perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR &&
    (result.perms & flag) !== flag
  ) {
    // For VIEW_CHANNEL specifically, return 404 to avoid leaking existence.
    if (flag === Permission.VIEW_CHANNEL) {
      throw TavernError.notFound('Channel not found');
    }
    throw TavernError.forbidden();
  }
  return result;
}

/**
 * Filter a list of channels (all from the same server) to the ones the user
 * can VIEW. DB-002: this used to be O(N) sequential `getChannelPermissions`
 * round-trips per request (each issuing ~5 queries of its own = O(5N) for a
 * single channel-list response). Now: 1 member-context query + 1 channel
 * lookup + 1 batched overwrites query, regardless of N.
 *
 * If the caller passes channels from multiple servers, we fall back to the
 * per-channel path so behaviour stays correct; the optimised path only
 * activates when all channels share a serverId we can resolve from a single
 * representative channel.
 */
export async function filterVisibleChannels<T extends { id: string }>(
  channels: T[],
  userId: string,
): Promise<T[]> {
  if (channels.length === 0) return [];

  // Look up the server for the first channel; if all channels share a server,
  // we batch. The shared-server invariant is held by every current caller
  // (`/api/servers/:id/channels` and `/api/servers/:serverId/search`).
  const channelIds = channels.map((c) => c.id);
  const channelRows = await prisma.channel.findMany({
    where: { id: { in: channelIds } },
    select: { id: true, serverId: true },
  });
  const serverIds = new Set(channelRows.map((r) => r.serverId));
  if (serverIds.size !== 1 || channelRows.length !== channels.length) {
    // Mixed-server input — fall back to per-channel evaluation.
    const visible: T[] = [];
    for (const c of channels) {
      const result = await getChannelPermissions(c.id, userId);
      if (!result) continue;
      if (
        (result.perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR ||
        (result.perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL
      ) {
        visible.push(c);
      }
    }
    return visible;
  }

  const [serverId] = serverIds;
  if (!serverId) return [];
  const ctx = await loadMemberContext(serverId, userId);
  if (!ctx) return [];
  if (ctx.isOwner) return [...channels];

  const allOverwrites = await prisma.permissionOverwrite.findMany({
    where: { channelId: { in: channelIds } },
  });
  const overwritesByChannel = new Map<string, typeof allOverwrites>();
  for (const o of allOverwrites) {
    const list = overwritesByChannel.get(o.channelId) ?? [];
    list.push(o);
    overwritesByChannel.set(o.channelId, list);
  }

  const visible: T[] = [];
  for (const c of channels) {
    const overwrites = overwritesByChannel.get(c.id) ?? [];
    let everyoneOverwrite: ResolvedOverwrite | undefined;
    let userOverwrite: ResolvedOverwrite | undefined;
    const roleOverwrites: ResolvedOverwrite[] = [];

    for (const o of overwrites) {
      const allow = parsePermissions(o.allow.toString());
      const deny = parsePermissions(o.deny.toString());
      if (o.targetType === 'role') {
        if (o.targetId === ctx.everyoneRoleId) {
          everyoneOverwrite = { allow, deny };
        } else if (ctx.roleIds.includes(o.targetId)) {
          roleOverwrites.push({ allow, deny });
        }
      } else if (o.targetType === 'user' && o.targetId === userId) {
        userOverwrite = { allow, deny };
      }
    }

    const perms = computeChannelPermissions({
      isOwner: false,
      everyoneRolePermissions: ctx.everyonePerms,
      rolePermissions: ctx.rolePerms,
      everyoneChannelOverwrite: everyoneOverwrite,
      roleChannelOverwrites: roleOverwrites,
      userChannelOverwrite: userOverwrite,
    });
    if (
      (perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR ||
      (perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL
    ) {
      visible.push(c);
    }
  }
  return visible;
}

/** Permissions encoded for API response. */
export function permsToString(p: bigint): string {
  return p.toString();
}

interface ActorRoleContext {
  isOwner: boolean;
  /** Highest position among the actor's roles, or 0 if they only hold @everyone. Infinity for owners. */
  maxRolePosition: number;
  /** Aggregated permissions across @everyone + all held roles (owner=PERMISSION_ALL). */
  effectivePerms: bigint;
}

/**
 * Resolve the actor's role hierarchy context for a given server. Used by
 * routes that mutate roles or role assignments to enforce Discord-style
 * hierarchy ("you can only manage roles strictly below your highest role,
 * and you cannot grant permissions you do not yourself hold").
 *
 * Returns null if the actor is not a member and not the owner.
 */
export async function getActorRoleContext(
  serverId: string,
  userId: string,
): Promise<ActorRoleContext | null> {
  const ctx = await loadMemberContext(serverId, userId);
  if (!ctx) return null;
  if (ctx.isOwner) {
    return {
      isOwner: true,
      maxRolePosition: Number.POSITIVE_INFINITY,
      effectivePerms: PERMISSION_ALL,
    };
  }
  let maxRolePosition = 0;
  if (ctx.roleIds.length > 0) {
    const actorRoles = await prisma.role.findMany({
      where: { id: { in: ctx.roleIds } },
      select: { position: true },
    });
    for (const r of actorRoles) {
      if (r.position > maxRolePosition) maxRolePosition = r.position;
    }
  }
  const effectivePerms = computeBasePermissions({
    isOwner: false,
    everyoneRolePermissions: ctx.everyonePerms,
    rolePermissions: ctx.rolePerms,
  });
  return { isOwner: false, maxRolePosition, effectivePerms };
}

/**
 * Enforce Discord-style role hierarchy for role mutations / assignments.
 *
 * Each target role must satisfy BOTH:
 *  1. `position < actor.maxRolePosition` — you can't touch roles at or above
 *     your own highest role.
 *  2. `(permissions & ~actor.effectivePerms) === 0` — you can't grant a role
 *     that holds permissions you do not yourself hold.
 *
 * Server owners are exempt from both checks (they implicitly hold every
 * permission and rank above every role).
 *
 * Use this anywhere MANAGE_ROLES is otherwise the only check —
 * MANAGE_ROLES alone is not enough to authorize granting ADMINISTRATOR or
 * positioning a role above the actor's own. See docs/REVIEW/uploads-permissions.md
 * [PERM-001].
 */
export async function requireRoleHierarchy(
  serverId: string,
  actorUserId: string,
  targetRoles: ReadonlyArray<{ position: number; permissions: bigint }>,
): Promise<void> {
  const actor = await getActorRoleContext(serverId, actorUserId);
  if (!actor) throw TavernError.forbidden();
  if (actor.isOwner) return;
  for (const role of targetRoles) {
    if (role.position >= actor.maxRolePosition) {
      throw new TavernError(
        ErrorCodes.ROLE_HIERARCHY,
        'Cannot manage a role at or above your own highest role',
        403,
      );
    }
    if ((role.permissions & ~actor.effectivePerms) !== PERMISSION_NONE) {
      throw new TavernError(
        ErrorCodes.ROLE_HIERARCHY,
        'Cannot grant permissions you do not yourself hold',
        403,
      );
    }
  }
}

export type { Prisma };
