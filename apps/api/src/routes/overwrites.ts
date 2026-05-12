import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import {
  ErrorCodes,
  idSchema,
  parsePermissions,
  Permission,
  PERMISSION_NONE,
  serializePermissions,
  TavernError,
  ulid,
  upsertPermissionOverwriteRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getActorRoleContext,
  requireChannelPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';

function serialize(o: {
  id: string;
  channelId: string;
  targetType: string;
  targetId: string;
  allow: Prisma.Decimal;
  deny: Prisma.Decimal;
}) {
  return {
    id: o.id,
    channelId: o.channelId,
    targetType: o.targetType as 'role' | 'user',
    targetId: o.targetId,
    allow: o.allow.toString(),
    deny: o.deny.toString(),
  };
}

export async function registerOverwriteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/:id/overwrites', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(id, ctx.userId, Permission.VIEW_CHANNEL);
    const overwrites = await prisma.permissionOverwrite.findMany({ where: { channelId: id } });
    reply.send(ok(overwrites.map(serialize)));
  });

  app.put('/api/channels/:id/overwrites/:targetType/:targetId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const params = z
      .object({
        id: idSchema,
        targetType: z.enum(['role', 'user']),
        targetId: idSchema,
      })
      .parse(req.params);
    const body = upsertPermissionOverwriteRequestSchema.parse({
      ...(req.body as object),
      targetType: params.targetType,
      targetId: params.targetId,
    });
    const result = await requireChannelPermission(params.id, ctx.userId, Permission.MANAGE_ROLES);
    const allowBits = parsePermissions(body.allow);
    const denyBits = parsePermissions(body.deny);

    // PERM-005: overwrite targets must belong to the channel's server.
    if (params.targetType === 'role') {
      const role = await prisma.role.findUnique({
        where: { id: params.targetId },
        select: { serverId: true },
      });
      if (!role || role.serverId !== result.serverId) {
        throw TavernError.validation('Role does not belong to this server');
      }
    } else {
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: result.serverId, userId: params.targetId } },
        select: { userId: true },
      });
      if (!member) {
        throw TavernError.validation('User is not a member of this server');
      }
    }

    // PERM-003: an overwrite must not allow a permission the actor does not
    // themselves hold at the server scope. Without this, a mid-tier
    // MANAGE_ROLES holder could grant ADMINISTRATOR (or any other gated bit)
    // to themselves or a teammate via a per-channel allow.
    const actor = await getActorRoleContext(result.serverId, ctx.userId);
    if (!actor) throw TavernError.forbidden();
    if (!actor.isOwner && (allowBits & ~actor.effectivePerms) !== PERMISSION_NONE) {
      throw new TavernError(
        ErrorCodes.ROLE_HIERARCHY,
        'Cannot allow permissions you do not yourself hold',
        403,
      );
    }

    const overwrite = await prisma.permissionOverwrite.upsert({
      where: {
        channelId_targetType_targetId: {
          channelId: params.id,
          targetType: params.targetType,
          targetId: params.targetId,
        },
      },
      create: {
        id: ulid(),
        channelId: params.id,
        targetType: params.targetType,
        targetId: params.targetId,
        allow: new Prisma.Decimal(serializePermissions(allowBits)),
        deny: new Prisma.Decimal(serializePermissions(denyBits)),
      },
      update: {
        allow: new Prisma.Decimal(serializePermissions(allowBits)),
        deny: new Prisma.Decimal(serializePermissions(denyBits)),
      },
    });

    await writeAuditEntry({
      serverId: result.serverId,
      actorId: ctx.userId,
      action: 'channel.updated',
      targetType: 'channel.overwrite',
      targetId: params.id,
    });
    reply.send(ok(serialize(overwrite)));
  });

  app.delete('/api/channels/:id/overwrites/:targetType/:targetId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const params = z
      .object({
        id: idSchema,
        targetType: z.enum(['role', 'user']),
        targetId: idSchema,
      })
      .parse(req.params);
    await requireChannelPermission(params.id, ctx.userId, Permission.MANAGE_ROLES);
    try {
      await prisma.permissionOverwrite.delete({
        where: {
          channelId_targetType_targetId: {
            channelId: params.id,
            targetType: params.targetType,
            targetId: params.targetId,
          },
        },
      });
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2025') {
        throw TavernError.notFound();
      }
      throw err;
    }
    reply.send(ok({ ok: true }));
  });
}
