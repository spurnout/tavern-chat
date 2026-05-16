import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';

/**
 * Wave 3 #36 — Instance-admin storage breakdown. Aggregates bytes per
 * user and per server from the Attachment table.
 *
 * Access is gated on `User.isInstanceAdmin` (no per-server permission;
 * this is a platform-level dashboard).
 */
export async function registerAdminStorageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/storage', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!ctx.isInstanceAdmin) throw TavernError.forbidden('Instance admin required');

    const [byUser, byServer, total] = await Promise.all([
      prisma.attachment.groupBy({
        by: ['uploaderId'],
        where: { status: 'ready' },
        _sum: { sizeBytes: true },
        _count: { id: true },
      }),
      prisma.attachment.groupBy({
        by: ['serverId'],
        where: { status: 'ready', serverId: { not: null } },
        _sum: { sizeBytes: true },
        _count: { id: true },
      }),
      prisma.attachment.aggregate({
        where: { status: 'ready' },
        _sum: { sizeBytes: true },
        _count: { id: true },
      }),
    ]);

    // Fetch names for the top-N entries (cap at 50 each to keep the response small).
    const topUsers = byUser
      .slice()
      .sort(
        (a, b) =>
          Number(b._sum.sizeBytes ?? 0n) - Number(a._sum.sizeBytes ?? 0n),
      )
      .slice(0, 50);
    const topServers = byServer
      .slice()
      .sort(
        (a, b) =>
          Number(b._sum.sizeBytes ?? 0n) - Number(a._sum.sizeBytes ?? 0n),
      )
      .slice(0, 50);
    const users = await prisma.user.findMany({
      where: { id: { in: topUsers.map((u) => u.uploaderId) } },
      select: { id: true, username: true, displayName: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const servers = await prisma.server.findMany({
      where: { id: { in: topServers.filter((s) => s.serverId).map((s) => s.serverId!) } },
      select: { id: true, name: true },
    });
    const serverMap = new Map(servers.map((s) => [s.id, s]));

    reply.send(
      ok({
        total: {
          bytes: Number(total._sum.sizeBytes ?? 0n),
          count: total._count.id,
        },
        users: topUsers.map((u) => {
          const meta = userMap.get(u.uploaderId);
          return {
            userId: u.uploaderId,
            username: meta?.username ?? null,
            displayName: meta?.displayName ?? null,
            bytes: Number(u._sum.sizeBytes ?? 0n),
            count: u._count.id,
          };
        }),
        servers: topServers
          .filter((s) => s.serverId)
          .map((s) => {
            const meta = serverMap.get(s.serverId!);
            return {
              serverId: s.serverId,
              name: meta?.name ?? null,
              bytes: Number(s._sum.sizeBytes ?? 0n),
              count: s._count.id,
            };
          }),
      }),
    );
  });
}
