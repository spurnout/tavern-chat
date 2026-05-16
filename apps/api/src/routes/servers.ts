import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createServerRequestSchema,
  idSchema,
  Permission,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_NONE,
  serializePermissions,
  TavernError,
  ulid,
  updateMemberNicknameRequestSchema,
  updateServerRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  serializeChannel,
  serializeMember,
  serializeRole,
  serializeServer,
} from '../lib/serializers.js';
import {
  filterVisibleChannels,
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  // List my servers --------------------------------------------------------
  app.get('/api/servers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const memberships = await prisma.serverMember.findMany({
      where: { userId: ctx.userId },
      include: { server: true },
      orderBy: { joinedAt: 'asc' },
    });
    reply.send(ok(memberships.map((m) => serializeServer(m.server))));
  });

  // Create a server --------------------------------------------------------
  app.post('/api/servers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createServerRequestSchema.parse(req.body);

    const serverId = ulid();
    const everyoneRoleId = ulid();

    const server = await prisma.$transaction(async (tx) => {
      await tx.server.create({
        data: {
          id: serverId,
          ownerUserId: ctx.userId,
          name: body.name,
          description: body.description ?? null,
        },
      });
      await tx.role.create({
        data: {
          id: everyoneRoleId,
          serverId,
          name: '@everyone',
          color: 0,
          position: 0,
          isEveryone: true,
          permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
        },
      });
      const updated = await tx.server.update({
        where: { id: serverId },
        data: { defaultRoleId: everyoneRoleId },
      });
      await tx.serverMember.create({
        data: { serverId, userId: ctx.userId },
      });
      await tx.channel.create({
        data: {
          id: ulid(),
          serverId,
          type: 'text',
          name: 'general',
          topic: 'Welcome.',
          position: 0,
        },
      });
      await tx.safetyPolicy.create({
        data: { serverId },
      });
      return updated;
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'server.created',
      targetType: 'server',
      targetId: serverId,
    });

    reply.status(201).send(ok(serializeServer(server)));
  });

  // Get a single server (must be a member) ---------------------------------
  app.get('/api/servers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) throw TavernError.notFound('Server not found');
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: id, userId: ctx.userId } },
    });
    if (!member && server.ownerUserId !== ctx.userId) {
      throw TavernError.notFound('Server not found');
    }
    reply.send(ok(serializeServer(server)));
  });

  // Update a server --------------------------------------------------------
  app.patch('/api/servers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateServerRequestSchema.parse(req.body);
    await requireServerPermission(id, ctx.userId, Permission.MANAGE_SERVER);

    const updated = await prisma.server.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.iconAttachmentId !== undefined ? { iconAttachmentId: body.iconAttachmentId } : {}),
      },
    });

    await writeAuditEntry({
      serverId: id,
      actorId: ctx.userId,
      action: 'server.updated',
      targetType: 'server',
      targetId: id,
      metadata: body as Record<string, unknown>,
    });
    gatewayBroker.publish({
      type: 'SERVER_UPDATE',
      serverId: id,
      data: serializeServer(updated),
    });

    reply.send(ok(serializeServer(updated)));
  });

  // Delete a server (owner only) -------------------------------------------
  app.delete('/api/servers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) throw TavernError.notFound('Server not found');
    if (server.ownerUserId !== ctx.userId) throw TavernError.forbidden('Only the owner can delete a server');

    await prisma.server.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  // Members ----------------------------------------------------------------
  app.get('/api/servers/:id/members', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Server not found');
    const members = await prisma.serverMember.findMany({
      where: { serverId: id },
      include: {
        roles: true,
        user: { select: { id: true, displayName: true, username: true, presence: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
    reply.send(
      ok(
        members.map((m) =>
          serializeMember({
            serverId: m.serverId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            timeoutUntil: m.timeoutUntil,
            roles: m.roles,
            user: m.user,
          }),
        ),
      ),
    );
  });

  // Server-level permissions for the calling user. Returned as a decimal
  // BigInt string so the client can `& flag` against the existing Permission
  // bitset. Used by UI gates that need to know "can I do X on this server"
  // without round-tripping for every action.
  app.get('/api/servers/:id/permissions/me', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === PERMISSION_NONE) throw TavernError.notFound('Server not found');
    reply.send(ok({ serverId: id, permissions: serializePermissions(perms) }));
  });

  // Roles ------------------------------------------------------------------
  app.get('/api/servers/:id/roles', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Server not found');
    const roles = await prisma.role.findMany({
      where: { serverId: id },
      orderBy: { position: 'asc' },
    });
    reply.send(ok(roles.map((r) => serializeRole(r))));
  });

  // Edit a member's nickname (your own, or someone else's with MANAGE_NICKNAMES).
  app.patch('/api/servers/:serverId/members/:userId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId, userId } = z
      .object({ serverId: idSchema, userId: idSchema })
      .parse(req.params);
    const body = updateMemberNicknameRequestSchema.parse(req.body);

    // Editing someone else's nickname needs MANAGE_NICKNAMES; editing your
    // own is a basic civic right (any current member can rename themselves
    // on a server they belong to).
    if (ctx.userId !== userId) {
      await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_NICKNAMES);
    } else {
      const perms = await getServerPermissions(serverId, ctx.userId);
      if (perms === 0n) throw TavernError.notFound('Server not found');
    }

    const existing = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
      select: { userId: true },
    });
    if (!existing) throw TavernError.notFound('Member not found');

    await prisma.serverMember.update({
      where: { serverId_userId: { serverId, userId } },
      data: { nickname: body.nickname },
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: ctx.userId === userId ? 'member.nickname.self' : 'member.nickname.set',
      targetType: 'user',
      targetId: userId,
      metadata: { nickname: body.nickname },
    });

    gatewayBroker.publish({
      type: 'MEMBER_UPDATE',
      serverId,
      data: { serverId, userId, nickname: body.nickname },
    });

    reply.send(ok({ serverId, userId, nickname: body.nickname }));
  });

  // Channels ---------------------------------------------------------------
  app.get('/api/servers/:id/channels', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Server not found');
    const all = await prisma.channel.findMany({
      where: { serverId: id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    const visible = await filterVisibleChannels(all, ctx.userId);
    reply.send(ok(visible.map((c) => serializeChannel(c))));
  });
}
