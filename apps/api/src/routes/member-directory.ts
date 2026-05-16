import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const querySchema = z.object({
  q: z.string().max(120).optional(),
  presence: z.enum(['active', 'idle', 'dnd', 'offline']).optional(),
  roleId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/**
 * Wave 3 #39 — Server-wide member directory with filters.
 */
export async function registerMemberDirectoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/directory', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const query = querySchema.parse(req.query);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);

    const rows = await prisma.serverMember.findMany({
      where: {
        serverId,
        ...(query.roleId
          ? { roles: { some: { roleId: query.roleId } } }
          : {}),
        ...(query.q
          ? {
              OR: [
                { nickname: { contains: query.q, mode: 'insensitive' } },
                { user: { displayName: { contains: query.q, mode: 'insensitive' } } },
                { user: { username: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
        ...(query.presence
          ? { user: { presence: query.presence } }
          : {}),
        ...(query.cursor ? { userId: { gt: query.cursor } } : {}),
      },
      orderBy: { userId: 'asc' },
      take: query.limit,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            presence: true,
            customStatus: true,
            avatarAttachmentId: true,
          },
        },
        roles: { select: { roleId: true } },
      },
    });

    reply.send(
      ok({
        items: rows.map((m) => ({
          userId: m.userId,
          nickname: m.nickname,
          joinedAt: m.joinedAt.toISOString(),
          customStatus: m.customStatus ?? null,
          user: m.user,
          roleIds: m.roles.map((r) => r.roleId),
        })),
        nextCursor: rows.length === query.limit ? rows[rows.length - 1]?.userId ?? null : null,
      }),
    );
  });
}
