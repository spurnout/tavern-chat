import { prisma } from '@tavern/db';
import {
  ErrorCodes,
  TavernError,
} from '@tavern/shared';
import { requireRoleHierarchy } from './permissions-service.js';
import { writeAuditEntry } from './audit-service.js';
import { gatewayBroker } from './gateway-broker.js';

/**
 * Server ban service — backs the BAN_MEMBERS permission bit (PERM-002).
 *
 * A ban hard-removes the user from the server (deletes ServerMember + role
 * assignments + voice state), records a `ServerBan` row, writes an audit
 * entry, and emits a `GUILD_BAN_ADD` gateway event that the receiving client
 * treats as a force-disconnect signal.
 *
 * Hierarchy is enforced via `requireRoleHierarchy`: a moderator cannot ban
 * someone whose highest role is at or above their own. Server owners are
 * exempt.
 */

interface BanInput {
  serverId: string;
  targetUserId: string;
  actorUserId: string;
  reason?: string | null;
  expiresAt?: Date | null;
  /**
   * If set, soft-delete the target's messages in this server created within
   * the last `deleteWithinHours` (defaults to 24 when sweepRecentHours is
   * truthy without an explicit value).
   */
  sweepRecentHours?: number | null;
}

export async function banMember(input: BanInput): Promise<{ messagesDeleted: number }> {
  const { serverId, targetUserId, actorUserId, reason, expiresAt, sweepRecentHours } = input;
  if (targetUserId === actorUserId) {
    throw TavernError.validation('You cannot ban yourself');
  }

  // Server owners cannot be banned.
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerUserId: true },
  });
  if (!server) throw TavernError.notFound('Server not found');
  if (server.ownerUserId === targetUserId) {
    throw new TavernError(
      ErrorCodes.ROLE_HIERARCHY,
      'The server owner cannot be banned',
      403,
    );
  }

  // Hierarchy: actor must outrank every role the target holds. We model the
  // target's roles as the requirement set so requireRoleHierarchy enforces
  // both position and permission-subset rules.
  const targetMember = await prisma.serverMember.findUnique({
    where: { serverId_userId: { serverId, userId: targetUserId } },
    include: { roles: { include: { role: true } } },
  });
  if (targetMember) {
    const targetRoles = targetMember.roles.map((r) => ({
      position: r.role.position,
      permissions: BigInt(r.role.permissions.toString()),
    }));
    if (targetRoles.length > 0) {
      await requireRoleHierarchy(serverId, actorUserId, targetRoles);
    }
  }

  let messagesDeleted = 0;

  await prisma.$transaction(async (tx) => {
    // Upsert: re-banning an already-banned user updates the reason/expiry
    // rather than failing on a primary-key conflict.
    await tx.serverBan.upsert({
      where: { serverId_userId: { serverId, userId: targetUserId } },
      create: {
        serverId,
        userId: targetUserId,
        bannedByUserId: actorUserId,
        reason: reason ?? null,
        expiresAt: expiresAt ?? null,
      },
      update: {
        bannedByUserId: actorUserId,
        reason: reason ?? null,
        expiresAt: expiresAt ?? null,
      },
    });

    if (targetMember) {
      await tx.serverMemberRole.deleteMany({
        where: { serverId, userId: targetUserId },
      });
      await tx.serverMember.delete({
        where: { serverId_userId: { serverId, userId: targetUserId } },
      });
    }

    // Clear voice presence for the banned user in this server's voice rooms.
    await tx.voiceState.updateMany({
      where: { serverId, userId: targetUserId },
      data: { channelId: null, joinedAt: null, screenSharing: false, cameraOn: false },
    });

    // Optional sweep of the user's recent messages. Soft-delete to match the
    // existing message-deletion path (deletedAt + content cleared) so the
    // serializer hides the body without orphaning replies/threads.
    if (sweepRecentHours && sweepRecentHours > 0) {
      const cutoff = new Date(Date.now() - sweepRecentHours * 60 * 60 * 1000);
      const result = await tx.message.updateMany({
        where: {
          serverId,
          authorId: targetUserId,
          createdAt: { gte: cutoff },
          deletedAt: null,
        },
        data: { deletedAt: new Date(), content: '' },
      });
      messagesDeleted = result.count;
    }
  });

  await writeAuditEntry({
    serverId,
    actorId: actorUserId,
    action: 'member.banned',
    targetType: 'user',
    targetId: targetUserId,
    metadata: {
      reason: reason ?? null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      ...(sweepRecentHours
        ? { sweepRecentHours, messagesDeleted }
        : {}),
    },
  });

  gatewayBroker.publish({
    type: 'GUILD_BAN_ADD',
    serverId,
    userId: targetUserId,
    data: { serverId, userId: targetUserId },
  });

  return { messagesDeleted };
}

export async function unbanMember(input: {
  serverId: string;
  targetUserId: string;
  actorUserId: string;
}): Promise<void> {
  const { serverId, targetUserId, actorUserId } = input;
  const existing = await prisma.serverBan.findUnique({
    where: { serverId_userId: { serverId, userId: targetUserId } },
  });
  if (!existing) throw TavernError.notFound('No active ban for this user');
  await prisma.serverBan.delete({
    where: { serverId_userId: { serverId, userId: targetUserId } },
  });
  await writeAuditEntry({
    serverId,
    actorId: actorUserId,
    action: 'member.unbanned',
    targetType: 'user',
    targetId: targetUserId,
  });
  gatewayBroker.publish({
    type: 'GUILD_BAN_REMOVE',
    serverId,
    userId: targetUserId,
    data: { serverId, userId: targetUserId },
  });
}

/**
 * Predicate consulted by the gateway IDENTIFY handler and the invite-consume
 * path. Expired bans are not considered active and are cleaned up inline so
 * the table stays bounded.
 */
export async function isBanned(serverId: string, userId: string): Promise<boolean> {
  const ban = await prisma.serverBan.findUnique({
    where: { serverId_userId: { serverId, userId } },
  });
  if (!ban) return false;
  if (ban.expiresAt && ban.expiresAt <= new Date()) {
    // Best-effort cleanup; failures are non-fatal (next check will retry).
    await prisma.serverBan
      .delete({ where: { serverId_userId: { serverId, userId } } })
      .catch(() => undefined);
    return false;
  }
  return true;
}

/** List all active bans for a server. Expired entries pruned inline. */
export async function listBans(serverId: string): Promise<
  Array<{
    serverId: string;
    userId: string;
    bannedByUserId: string | null;
    reason: string | null;
    expiresAt: Date | null;
    createdAt: Date;
  }>
> {
  const now = new Date();
  const rows = await prisma.serverBan.findMany({
    where: { serverId },
    orderBy: { createdAt: 'desc' },
  });
  const live: typeof rows = [];
  const expiredIds: string[] = [];
  for (const r of rows) {
    if (r.expiresAt && r.expiresAt <= now) expiredIds.push(r.userId);
    else live.push(r);
  }
  if (expiredIds.length > 0) {
    await prisma.serverBan
      .deleteMany({ where: { serverId, userId: { in: expiredIds } } })
      .catch(() => undefined);
  }
  return live;
}

/** Return the set of serverIds the user is actively banned from. */
export async function activeBanServerIds(userId: string): Promise<Set<string>> {
  const now = new Date();
  const rows = await prisma.serverBan.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { serverId: true },
  });
  return new Set(rows.map((r) => r.serverId));
}
