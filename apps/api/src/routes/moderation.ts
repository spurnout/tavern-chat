import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createReportRequestSchema,
  idSchema,
  Permission,
  resolveReportRequestSchema,
  TavernError,
  ulid,
  updateSafetyPolicyRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

interface ReportRow {
  id: string;
  serverId: string | null;
  reporterId: string;
  targetType: string;
  targetId: string;
  category: string;
  notes: string | null;
  status: string;
  resolvedById: string | null;
  resolutionNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeReport(r: ReportRow) {
  return {
    id: r.id,
    serverId: r.serverId,
    reporterId: r.reporterId,
    targetType: r.targetType as never,
    targetId: r.targetId,
    category: r.category as never,
    notes: r.notes,
    status: r.status as never,
    resolvedById: r.resolvedById,
    resolutionNotes: r.resolutionNotes,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function registerModerationRoutes(app: FastifyInstance): Promise<void> {
  // Anyone can file a report on content they can see.
  app.post('/api/reports', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createReportRequestSchema.parse(req.body);
    const created = await prisma.report.create({
      data: {
        id: ulid(),
        serverId: body.serverId ?? null,
        reporterId: ctx.userId,
        targetType: body.targetType,
        targetId: body.targetId,
        category: body.category,
        notes: body.notes ?? null,
      },
    });
    await writeAuditEntry({
      serverId: body.serverId ?? null,
      actorId: ctx.userId,
      action: 'report.created',
      targetType: 'report',
      targetId: created.id,
      metadata: { category: body.category, targetType: body.targetType, targetId: body.targetId },
    });
    if (body.serverId) {
      gatewayBroker.publish({
        type: 'MODERATION_EVENT_CREATE',
        serverId: body.serverId,
        data: { kind: 'report.created', reportId: created.id },
      });
    }
    reply.status(201).send(ok(serializeReport(created as ReportRow)));
  });

  app.get('/api/servers/:serverId/moderation/queue', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_MODERATION_QUEUE);
    const reports = await prisma.report.findMany({
      where: { serverId, status: { in: ['open', 'in_review'] } },
      orderBy: { createdAt: 'asc' },
    });
    reply.send(ok(reports.map((r) => serializeReport(r as ReportRow))));
  });

  app.post('/api/reports/:id/resolve', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = resolveReportRequestSchema.parse(req.body);
    const report = await prisma.report.findUnique({ where: { id } });
    if (!report) throw TavernError.notFound();
    if (report.serverId) {
      await requireServerPermission(
        report.serverId,
        ctx.userId,
        Permission.MANAGE_REPORT_WORKFLOW,
      );
    } else {
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { isInstanceAdmin: true },
      });
      if (!me?.isInstanceAdmin) throw TavernError.forbidden();
    }
    const updated = await prisma.report.update({
      where: { id },
      data: {
        status: body.status,
        resolvedById: ctx.userId,
        resolutionNotes: body.notes ?? null,
      },
    });
    if (body.action) {
      await prisma.moderationAction.create({
        data: {
          id: ulid(),
          reportId: id,
          moderatorId: ctx.userId,
          serverId: report.serverId,
          targetType: report.targetType,
          targetId: report.targetId,
          action: body.action,
          notes: body.notes ?? null,
        },
      });

      // Concrete effects of the most common actions.
      if (body.action === 'block' || body.action === 'quarantine') {
        if (report.targetType === 'message') {
          await prisma.message.updateMany({
            where: { id: report.targetId },
            data: {
              deletedAt: new Date(),
              content: '',
              safetyState: body.action === 'quarantine' ? 'quarantined' : 'blocked',
            },
          });
        }
        if (report.targetType === 'attachment') {
          await prisma.attachment.updateMany({
            where: { id: report.targetId },
            data: { status: body.action === 'quarantine' ? 'quarantined' : 'blocked' },
          });
        }
      }
      if (body.action === 'lock_account') {
        // Reasonable default: 30-day posting + upload lock. Operators can extend manually.
        const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        // Find the offending user via the target row.
        let offenderId: string | null = null;
        if (report.targetType === 'message') {
          const m = await prisma.message.findUnique({
            where: { id: report.targetId },
            select: { authorId: true },
          });
          offenderId = m?.authorId ?? null;
        } else if (report.targetType === 'attachment') {
          const a = await prisma.attachment.findUnique({
            where: { id: report.targetId },
            select: { uploaderId: true },
          });
          offenderId = a?.uploaderId ?? null;
        }
        if (offenderId) {
          await prisma.user.update({
            where: { id: offenderId },
            data: { postingLockedUntil: until, uploadsLockedUntil: until },
          });
          await writeAuditEntry({
            serverId: report.serverId,
            actorId: ctx.userId,
            action: 'user.posting_locked',
            targetType: 'user',
            targetId: offenderId,
            metadata: { until: until.toISOString() },
          });
        }
      }
    }
    await writeAuditEntry({
      serverId: report.serverId,
      actorId: ctx.userId,
      action: 'report.resolved',
      targetType: 'report',
      targetId: id,
      metadata: { status: body.status, action: body.action ?? null },
    });
    reply.send(ok(serializeReport(updated as ReportRow)));
  });

  // Server safety policy ---------------------------------------------------
  app.get('/api/servers/:serverId/safety-policy', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    if ((await getServerPermissions(serverId, ctx.userId)) === 0n) throw TavernError.notFound();
    const policy = await prisma.safetyPolicy.findUnique({ where: { serverId } });
    if (!policy) throw TavernError.notFound();
    reply.send(ok({ ...policy, updatedAt: policy.updatedAt.toISOString() }));
  });

  app.patch('/api/servers/:serverId/safety-policy', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    const body = updateSafetyPolicyRequestSchema.parse(req.body);
    await requireServerPermission(
      serverId,
      ctx.userId,
      Permission.MANAGE_SERVER_SAFETY_POLICY,
    );
    const updated = await prisma.safetyPolicy.update({
      where: { serverId },
      data: body,
    });
    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'safety_policy.updated',
      targetType: 'safety_policy',
      targetId: serverId,
      metadata: body,
    });
    reply.send(ok({ ...updated, updatedAt: updated.updatedAt.toISOString() }));
  });

  // Audit log --------------------------------------------------------------
  app.get('/api/servers/:serverId/audit-log', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_AUDIT_LOG);
    const entries = await prisma.auditLogEntry.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    reply.send(
      ok(
        entries.map((e) => ({
          id: e.id,
          serverId: e.serverId,
          actorId: e.actorId,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          metadata: e.metadata ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      ),
    );
  });
}
