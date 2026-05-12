import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import {
  assignRolesRequestSchema,
  createRoleRequestSchema,
  idSchema,
  parsePermissions,
  Permission,
  PERMISSION_NONE,
  serializePermissions,
  TavernError,
  ulid,
  updateRoleRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeRole } from '../lib/serializers.js';
import { requireRoleHierarchy, requireServerPermission } from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

export async function registerRoleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/servers/:serverId/roles', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = createRoleRequestSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_ROLES);

    const last = await prisma.role.findFirst({
      where: { serverId, isEveryone: false },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const newPosition = (last?.position ?? 0) + 1;
    const newPerms = parsePermissions(body.permissions ?? '0');

    // Hierarchy gate: actor cannot create a role with permissions they do not
    // themselves hold, even though they have MANAGE_ROLES. See PERM-001.
    await requireRoleHierarchy(serverId, ctx.userId, [
      { position: newPosition, permissions: newPerms },
    ]);

    const role = await prisma.role.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        color: body.color ?? 0,
        permissions: new Prisma.Decimal(serializePermissions(newPerms)),
        mentionable: body.mentionable ?? false,
        hoist: body.hoist ?? false,
        position: newPosition,
      },
    });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'role.created',
      targetType: 'role',
      targetId: role.id,
    });
    gatewayBroker.publish({ type: 'ROLE_CREATE', serverId, data: serializeRole(role) });
    reply.status(201).send(ok(serializeRole(role)));
  });

  app.patch('/api/roles/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateRoleRequestSchema.parse(req.body);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw TavernError.notFound('Role not found');
    await requireServerPermission(role.serverId, ctx.userId, Permission.MANAGE_ROLES);

    // Hierarchy gate: the role's existing position and permissions must both
    // be below the actor's, and the post-update permissions must still be a
    // subset of the actor's own. Otherwise MANAGE_ROLES alone could let a
    // mid-tier moderator add ADMINISTRATOR to any role. See PERM-001.
    const existingPerms = parsePermissions(role.permissions.toString());
    const proposedPerms =
      body.permissions !== undefined ? parsePermissions(body.permissions) : existingPerms;
    const proposedPosition = body.position !== undefined ? body.position : role.position;
    await requireRoleHierarchy(role.serverId, ctx.userId, [
      { position: role.position, permissions: existingPerms },
      { position: proposedPosition, permissions: proposedPerms },
    ]);

    const updated = await prisma.role.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.mentionable !== undefined ? { mentionable: body.mentionable } : {}),
        ...(body.hoist !== undefined ? { hoist: body.hoist } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.permissions !== undefined
          ? {
              permissions: new Prisma.Decimal(serializePermissions(proposedPerms)),
            }
          : {}),
      },
    });
    await writeAuditEntry({
      serverId: role.serverId,
      actorId: ctx.userId,
      action: 'role.updated',
      targetType: 'role',
      targetId: id,
    });
    gatewayBroker.publish({
      type: 'ROLE_UPDATE',
      serverId: role.serverId,
      data: serializeRole(updated),
    });
    reply.send(ok(serializeRole(updated)));
  });

  app.delete('/api/roles/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw TavernError.notFound('Role not found');
    if (role.isEveryone) throw TavernError.validation('Cannot delete @everyone');
    await requireServerPermission(role.serverId, ctx.userId, Permission.MANAGE_ROLES);
    await prisma.role.delete({ where: { id } });
    await writeAuditEntry({
      serverId: role.serverId,
      actorId: ctx.userId,
      action: 'role.deleted',
      targetType: 'role',
      targetId: id,
    });
    gatewayBroker.publish({ type: 'ROLE_DELETE', serverId: role.serverId, data: { id } });
    reply.send(ok({ id }));
  });

  // Assign roles to a member
  app.put('/api/servers/:serverId/members/:userId/roles', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId, userId } = z
      .object({ serverId: idSchema, userId: idSchema })
      .parse(req.params);
    const body = assignRolesRequestSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_ROLES);

    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (!member) throw TavernError.notFound('Member not found');

    const roles = await prisma.role.findMany({
      where: { id: { in: body.roleIds }, serverId, isEveryone: false },
      select: { id: true, position: true, permissions: true },
    });
    const validIds = new Set(roles.map((r) => r.id));
    if (validIds.size !== body.roleIds.length) {
      throw TavernError.validation('Unknown role id');
    }

    // Hierarchy gate: every role being assigned must be below the actor's
    // highest role AND must only carry permissions the actor themselves has.
    // Prevents a mid-tier MANAGE_ROLES holder from granting ADMINISTRATOR.
    // See PERM-001.
    await requireRoleHierarchy(
      serverId,
      ctx.userId,
      roles.map((r) => ({
        position: r.position,
        permissions: parsePermissions(r.permissions.toString()),
      })),
    );

    await prisma.$transaction(async (tx) => {
      await tx.serverMemberRole.deleteMany({ where: { serverId, userId } });
      if (validIds.size > 0) {
        await tx.serverMemberRole.createMany({
          data: Array.from(validIds).map((roleId) => ({ serverId, userId, roleId })),
        });
      }
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'role.assigned',
      targetType: 'user',
      targetId: userId,
      metadata: { roleIds: Array.from(validIds) },
    });
    gatewayBroker.publish({
      type: 'MEMBER_UPDATE',
      serverId,
      data: { serverId, userId, roles: Array.from(validIds) },
    });

    void PERMISSION_NONE;
    reply.send(ok({ serverId, userId, roles: Array.from(validIds) }));
  });
}
