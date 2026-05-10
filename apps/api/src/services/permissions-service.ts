import { Prisma, prisma } from '@tavern/db';
import {
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
}

async function loadMemberContext(serverId: string, userId: string): Promise<MemberInfo | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerUserId: true, defaultRoleId: true },
  });
  if (!server) return null;

  const isOwner = server.ownerUserId === userId;

  const member = await prisma.serverMember.findUnique({
    where: { serverId_userId: { serverId, userId } },
    include: {
      roles: { include: { role: true } },
    },
  });
  if (!member && !isOwner) return null;

  let everyonePerms = PERMISSION_NONE;
  if (server.defaultRoleId) {
    const everyone = await prisma.role.findUnique({
      where: { id: server.defaultRoleId },
      select: { permissions: true },
    });
    if (everyone) everyonePerms = parsePermissions(everyone.permissions.toString());
  }

  const rolePerms = (member?.roles ?? []).map((r) =>
    parsePermissions(r.role.permissions.toString()),
  );
  const roleIds = (member?.roles ?? []).map((r) => r.role.id);

  return { isOwner, everyonePerms, rolePerms, roleIds };
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

  const everyoneRoleIdRow = await prisma.server.findUnique({
    where: { id: channel.serverId },
    select: { defaultRoleId: true },
  });
  const everyoneRoleId = everyoneRoleIdRow?.defaultRoleId ?? null;

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

/** Filters a list of channels down to the ones the user can VIEW. */
export async function filterVisibleChannels<T extends { id: string }>(
  channels: T[],
  userId: string,
): Promise<T[]> {
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

/** Permissions encoded for API response. */
export function permsToString(p: bigint): string {
  return p.toString();
}

export type { Prisma };
