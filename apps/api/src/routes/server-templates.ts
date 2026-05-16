import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const createFromServerSchema = z.object({
  serverId: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

const instantiateSchema = z.object({
  name: z.string().min(1).max(120),
});

/**
 * Wave 3 #19 — Server templates. Snapshot a tavern's category/channel/role
 * layout as a portable JSON payload, then instantiate fresh taverns from it.
 *
 * The snapshot is intentionally lightweight: structural only, no messages or
 * member data. Operators handle data migrations with the backup/restore
 * route instead.
 */
export async function registerServerTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/server-templates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    // List both global templates (no scope) and templates this user authored.
    const rows = await prisma.serverTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    void ctx;
    reply.send(ok(rows));
  });

  app.post('/api/server-templates', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createFromServerSchema.parse(req.body);
    await requireServerPermission(body.serverId, ctx.userId, Permission.MANAGE_SERVER);

    const [server, channels, roles] = await Promise.all([
      prisma.server.findUniqueOrThrow({ where: { id: body.serverId } }),
      prisma.channel.findMany({ where: { serverId: body.serverId } }),
      prisma.role.findMany({ where: { serverId: body.serverId } }),
    ]);

    const payload = {
      version: 1,
      server: {
        name: server.name,
        description: server.description,
      },
      channels: channels.map((c) => ({
        type: c.type,
        name: c.name,
        topic: c.topic,
        position: c.position,
        nsfw: c.nsfw,
        videoEnabled: c.videoEnabled,
        slowmodeSeconds: c.slowmodeSeconds,
        postingScope: c.postingScope,
        parentName: c.parentId
          ? channels.find((x) => x.id === c.parentId)?.name ?? null
          : null,
      })),
      roles: roles
        .filter((r) => !r.isEveryone)
        .map((r) => ({
          name: r.name,
          color: r.color,
          position: r.position,
          permissions: r.permissions.toString(),
          mentionable: r.mentionable,
          hoist: r.hoist,
        })),
    };

    const tpl = await prisma.serverTemplate.create({
      data: {
        id: ulid(),
        authorId: ctx.userId,
        name: body.name,
        description: body.description ?? null,
        payloadJson: payload as object,
        iconAttachmentId: server.iconAttachmentId ?? null,
      },
    });
    reply.status(201).send(ok(tpl));
  });

  app.post('/api/server-templates/:id/instantiate', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = instantiateSchema.parse(req.body);
    const tpl = await prisma.serverTemplate.findUnique({ where: { id } });
    if (!tpl) throw TavernError.notFound('Template not found');

    const payload = tpl.payloadJson as {
      version: number;
      server: { name: string; description: string | null };
      channels: Array<{
        type: string;
        name: string;
        topic: string | null;
        position: number;
        nsfw: boolean;
        videoEnabled: boolean;
        slowmodeSeconds?: number;
        postingScope?: 'open' | 'mods_only' | 'admin_only';
        parentName: string | null;
      }>;
      roles: Array<{
        name: string;
        color: number;
        position: number;
        permissions: string;
        mentionable: boolean;
        hoist: boolean;
      }>;
    };

    // Create the server + everyone role + channels in a transaction.
    const newServerId = ulid();
    const newServer = await prisma.$transaction(async (tx) => {
      const everyoneId = ulid();
      const server = await tx.server.create({
        data: {
          id: newServerId,
          ownerUserId: ctx.userId,
          name: body.name,
          description: payload.server.description ?? null,
          defaultRoleId: everyoneId,
        },
      });
      await tx.role.create({
        data: {
          id: everyoneId,
          serverId: newServerId,
          name: '@everyone',
          permissions: '0',
          position: 0,
          isEveryone: true,
        },
      });
      await tx.serverMember.create({
        data: { serverId: newServerId, userId: ctx.userId },
      });
      // Custom roles.
      for (const r of payload.roles) {
        await tx.role.create({
          data: {
            id: ulid(),
            serverId: newServerId,
            name: r.name,
            color: r.color,
            position: r.position,
            permissions: r.permissions,
            mentionable: r.mentionable,
            hoist: r.hoist,
          },
        });
      }
      // Channels — pass 1: categories. Pass 2: everything else, linking parent.
      const categoryByName = new Map<string, string>();
      for (const c of payload.channels.filter((c) => c.type === 'category')) {
        const cid = ulid();
        categoryByName.set(c.name, cid);
        await tx.channel.create({
          data: {
            id: cid,
            serverId: newServerId,
            type: 'category',
            name: c.name,
            topic: c.topic,
            position: c.position,
          },
        });
      }
      for (const c of payload.channels.filter((c) => c.type !== 'category')) {
        await tx.channel.create({
          data: {
            id: ulid(),
            serverId: newServerId,
            type: c.type as never,
            name: c.name,
            topic: c.topic,
            position: c.position,
            nsfw: c.nsfw,
            videoEnabled: c.videoEnabled,
            slowmodeSeconds: c.slowmodeSeconds ?? 0,
            postingScope: (c.postingScope ?? 'open') as never,
            parentId: c.parentName ? categoryByName.get(c.parentName) ?? null : null,
          },
        });
      }
      return server;
    });

    reply.status(201).send(ok({ id: newServer.id, name: newServer.name }));
  });

  app.delete('/api/server-templates/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const tpl = await prisma.serverTemplate.findUnique({ where: { id } });
    if (!tpl) throw TavernError.notFound('Template not found');
    if (tpl.authorId !== ctx.userId) throw TavernError.forbidden();
    await prisma.serverTemplate.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
