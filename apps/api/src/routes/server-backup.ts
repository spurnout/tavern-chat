import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import type { StorageBackend } from '@tavern/media';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { runServerBackupJob } from '../services/server-backup-service.js';

interface ServerBackupRouteOpts {
  storage: StorageBackend;
}

/**
 * Wave 3 #20 — Server backup. Three endpoints:
 *   - POST /servers/:id/backups — kick off a backup job
 *   - GET  /servers/:id/backups — list job rows
 *   - GET  /server-backups/:id/download — owner-only zip download
 *
 * Restore is intentionally NOT implemented here — it has its own
 * conflict-resolution semantics (rewrite IDs, merge with existing rows,
 * etc.) and warrants a dedicated PR. The backup files are JSONL-per-table
 * so a future restore tool can replay them in dependency order.
 */
export async function registerServerBackupRoutes(
  app: FastifyInstance,
  opts: ServerBackupRouteOpts,
): Promise<void> {
  app.get('/api/servers/:id/backups', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER);
    const rows = await prisma.serverBackup.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        sizeBytes: true,
        failureReason: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    reply.send(
      ok(
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          sizeBytes: r.sizeBytes,
          failureReason: r.failureReason,
          createdAt: r.createdAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          finishedAt: r.finishedAt?.toISOString() ?? null,
        })),
      ),
    );
  });

  app.post('/api/servers/:id/backups', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
      await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER);
      // Per-server cooldown: refuse to start a second backup while one is
      // already inflight. Backups are heavy; a runaway button-press shouldn't
      // turn into N concurrent zip builds.
      const inflight = await prisma.serverBackup.findFirst({
        where: { serverId, status: { in: ['pending', 'running'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      });
      if (inflight) {
        return reply.status(202).send(ok({ id: inflight.id, status: inflight.status }));
      }
      const jobId = ulid();
      await prisma.serverBackup.create({
        data: {
          id: jobId,
          serverId,
          createdBy: ctx.userId,
          status: 'pending',
        },
      });
      void runServerBackupJob(jobId, opts.storage, app.log).catch(() => undefined);
      reply.status(202).send(ok({ id: jobId, status: 'pending' }));
    },
  });

  app.delete('/api/server-backups/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const b = await prisma.serverBackup.findUnique({ where: { id } });
    if (!b) throw TavernError.notFound('Backup not found');
    await requireServerPermission(b.serverId, ctx.userId, Permission.MANAGE_SERVER);
    // If the zip exists, drop it from storage first; otherwise we orphan
    // bytes in the bucket every time someone tidies their backups list.
    if (b.storageBucket && b.storageKey) {
      // Bypass the StorageBackend type for the cast — both backends expose
      // removeObject and we don't want to require it explicitly above.
      await opts.storage.removeObject(b.storageBucket, b.storageKey).catch(() => undefined);
    }
    await prisma.serverBackup.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  app.get('/api/server-backups/:id/download', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const b = await prisma.serverBackup.findUnique({ where: { id } });
    if (!b) throw TavernError.notFound('Backup not found');
    await requireServerPermission(b.serverId, ctx.userId, Permission.MANAGE_SERVER);
    if (b.status !== 'ready' || !b.storageBucket || !b.storageKey) {
      throw TavernError.validation('Backup is not ready yet');
    }
    const stream = await opts.storage.getObject(b.storageBucket, b.storageKey);
    reply.header('content-type', 'application/zip');
    reply.header(
      'content-disposition',
      `attachment; filename="tavern-server-${b.serverId}-${id}.zip"`,
    );
    if (b.sizeBytes) reply.header('content-length', String(b.sizeBytes));
    return reply.send(stream);
  });
}
