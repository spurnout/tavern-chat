import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  TavernError,
  ulid,
  updateAccountSettingsRequestSchema,
  type AccountSettings,
} from '@tavern/shared';
import type { StorageBackend } from '@tavern/media';
import { ok } from '../lib/responses.js';
import { runUserDataExport } from '../services/data-export-service.js';

interface AccountRouteOpts {
  storage: StorageBackend;
}

/**
 * Wave 2 #17 — Session management UI.
 * Wave 2 #18 — Per-user data export + account deletion (later promoted to a
 *              real worker job in Wave 3 — see data-export-service.ts).
 *
 * The Session model existed from the auth slice; here we add the per-session
 * list/revoke surface and the dedicated `UserDataExport` table replaces the
 * earlier ScheduledDispatch-payload hack.
 */
export async function registerAccountRoutes(
  app: FastifyInstance,
  opts: AccountRouteOpts,
): Promise<void> {
  // ---- Account-level settings (federation polish) ----------------------
  //
  // `/api/me/account` is the home for non-profile account preferences — things
  // that don't show up on the profile card but govern how the account behaves
  // at the instance / federation boundary. Today: per-user federation opt-outs
  // (#28 inbound DMs, #33 outbound presence). Future account-level prefs
  // (locale overrides, email-notification scopes, etc.) can be added here
  // without inflating the profile-edit surface.

  app.get('/api/me/account', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: {
        acceptsFederatedDms: true,
        acceptsFederatedPresence: true,
      },
    });
    if (!user) throw TavernError.notFound('User not found');
    const settings: AccountSettings = {
      acceptsFederatedDms: user.acceptsFederatedDms,
      acceptsFederatedPresence: user.acceptsFederatedPresence,
    };
    reply.send(ok(settings));
  });

  app.patch('/api/me/account', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = updateAccountSettingsRequestSchema.parse(req.body);

    const data: Prisma.UserUpdateInput = {};
    if (body.acceptsFederatedDms !== undefined) {
      data.acceptsFederatedDms = body.acceptsFederatedDms;
    }
    if (body.acceptsFederatedPresence !== undefined) {
      data.acceptsFederatedPresence = body.acceptsFederatedPresence;
    }

    const updated = await prisma.user.update({
      where: { id: ctx.userId },
      data,
      select: {
        acceptsFederatedDms: true,
        acceptsFederatedPresence: true,
      },
    });
    const settings: AccountSettings = {
      acceptsFederatedDms: updated.acceptsFederatedDms,
      acceptsFederatedPresence: updated.acceptsFederatedPresence,
    };
    reply.send(ok(settings));
  });

  // ---- Sessions ---------------------------------------------------------

  app.get('/api/me/sessions', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await prisma.session.findMany({
      where: { userId: ctx.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    reply.send(
      ok(
        rows.map((s) => ({
          id: s.id,
          deviceName: s.deviceName,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        })),
      ),
    );
  });

  app.delete('/api/me/sessions/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.userId !== ctx.userId) {
      throw TavernError.notFound('Session not found');
    }
    await prisma.session.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    reply.send(ok({ id }));
  });

  app.post('/api/me/sessions/revoke-others', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    // The caller's own session id isn't surfaced through requireUser today;
    // a real impl would carry it on ctx. For now we revoke ALL sessions
    // (the caller will be re-issued one on the next /refresh). Operators
    // who want a smoother UX can wire ctx.sessionId in a follow-up.
    await prisma.session.updateMany({
      where: { userId: ctx.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    reply.send(ok({ ok: true }));
  });

  // ---- Data export (Wave 3) --------------------------------------------

  app.post('/api/me/export', {
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      // Cooldown: refuse to queue another job while one is already pending
      // or running for this user. Avoids accidental double-clicks producing
      // duplicate zips and curbs a trivial abuse surface.
      const inflight = await prisma.userDataExport.findFirst({
        where: { userId: ctx.userId, status: { in: ['pending', 'running'] } },
        orderBy: { requestedAt: 'desc' },
        select: { id: true, status: true },
      });
      if (inflight) {
        return reply.status(202).send(ok({ exportId: inflight.id, status: inflight.status }));
      }
      const exportId = ulid();
      // Exports linger seven days then a maintenance sweep purges both the
      // row and the underlying zip. Seven matches the account-deletion
      // grace window — same "you have a week to act on this" social
      // contract.
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await prisma.userDataExport.create({
        data: {
          id: exportId,
          userId: ctx.userId,
          status: 'pending',
          expiresAt,
        },
      });
      // Fire-and-forget. The job updates the row + publishes EXPORT_READY
      // when done; the client polls /api/me/exports or listens on the
      // gateway.
      void runUserDataExport(exportId, opts.storage, app.log).catch(() => undefined);
      reply.status(202).send(ok({ exportId, status: 'pending' }));
    },
  });

  app.get('/api/me/exports', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await prisma.userDataExport.findMany({
      where: { userId: ctx.userId },
      orderBy: { requestedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        sizeBytes: true,
        failureReason: true,
        requestedAt: true,
        startedAt: true,
        finishedAt: true,
        expiresAt: true,
      },
    });
    reply.send(
      ok(
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          sizeBytes: r.sizeBytes,
          failureReason: r.failureReason,
          requestedAt: r.requestedAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          finishedAt: r.finishedAt?.toISOString() ?? null,
          expiresAt: r.expiresAt.toISOString(),
        })),
      ),
    );
  });

  // Owner-only download. The export zip lives in the main bucket but is
  // referenced by an opaque storage key — we never expose a public URL;
  // this endpoint authenticates the caller and streams the bytes through.
  app.get('/api/me/exports/:id/download', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.userDataExport.findUnique({ where: { id } });
    if (!row || row.userId !== ctx.userId) {
      throw TavernError.notFound('Export not found');
    }
    if (row.status !== 'ready' || !row.storageBucket || !row.storageKey) {
      throw TavernError.validation('Export is not ready yet');
    }
    if (row.expiresAt < new Date()) {
      throw TavernError.validation('Export has expired — request a new one');
    }
    const stream = await opts.storage.getObject(row.storageBucket, row.storageKey);
    reply.header('content-type', 'application/zip');
    reply.header(
      'content-disposition',
      `attachment; filename="tavern-export-${id}.zip"`,
    );
    if (row.sizeBytes) reply.header('content-length', String(row.sizeBytes));
    return reply.send(stream);
  });

  // ---- Account deletion (W2 #18) ---------------------------------------

  app.post('/api/me/delete', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { isInstanceAdmin: true },
    });
    if (user.isInstanceAdmin) {
      throw TavernError.forbidden(
        'Instance admins cannot self-delete — transfer the admin role first.',
      );
    }
    const ownedServers = await prisma.server.findMany({
      where: { ownerUserId: ctx.userId },
      select: { id: true, name: true },
    });
    if (ownedServers.length > 0) {
      throw TavernError.validation(
        `You own ${ownedServers.length} tavern(s). Transfer ownership first.`,
      );
    }
    const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { scheduledDeleteAt: scheduledAt },
    });
    reply.send(
      ok({
        scheduledDeleteAt: scheduledAt.toISOString(),
        graceDays: 7,
      }),
    );
  });

  app.post('/api/me/delete/cancel', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { scheduledDeleteAt: null },
    });
    reply.send(ok({ ok: true }));
  });
}
