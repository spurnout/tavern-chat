import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createServerRequestSchema,
  idSchema,
  Permission,
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  TavernError,
  ulid,
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
      include: { roles: true },
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
          }),
        ),
      ),
    );
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
