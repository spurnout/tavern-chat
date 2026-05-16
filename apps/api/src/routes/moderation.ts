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

function formatReportAuditAction(action: string): string {
  switch (action) {
    case 'report.created':
      return 'Report opened.';
    case 'report.resolved':
      return 'Report resolved.';
    case 'member.banned':
      return 'Reported member was removed from the tavern.';
    case 'member.timed_out':
      return 'Reported member was timed out.';
    case 'message.deleted':
      return 'The reported message was deleted.';
    case 'message.quarantined':
      return 'The reported message was quarantined.';
    case 'attachment.blocked':
      return 'The reported attachment was blocked.';
    default:
      return action;
  }
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

    // Enrich each report with reporter/target display names, an optional
    // preview, and a small timeline derived from related audit entries.
    const reporterIds = Array.from(new Set(reports.map((r) => r.reporterId)));
    const reportIds = reports.map((r) => r.id);
    const messageTargetIds = reports
      .filter((r) => r.targetType === 'message')
      .map((r) => r.targetId);
    const attachmentTargetIds = reports
      .filter((r) => r.targetType === 'attachment')
      .map((r) => r.targetId);
    const profileTargetIds = reports
      .filter((r) => r.targetType === 'profile')
      .map((r) => r.targetId);

    const [reporters, messageTargets, attachmentTargets, profileTargets, auditRows] =
      await Promise.all([
        reporterIds.length
          ? prisma.user.findMany({
              where: { id: { in: reporterIds } },
              select: { id: true, displayName: true },
            })
          : Promise.resolve([]),
        messageTargetIds.length
          ? prisma.message.findMany({
              where: { id: { in: messageTargetIds } },
              select: { id: true, authorId: true, content: true },
            })
          : Promise.resolve([]),
        attachmentTargetIds.length
          ? prisma.attachment.findMany({
              where: { id: { in: attachmentTargetIds } },
              select: { id: true, uploaderId: true, filename: true },
            })
          : Promise.resolve([]),
        profileTargetIds.length
          ? prisma.user.findMany({
              where: { id: { in: profileTargetIds } },
              select: { id: true, displayName: true },
            })
          : Promise.resolve([]),
        reportIds.length
          ? prisma.auditLogEntry.findMany({
              where: {
                serverId,
                targetType: 'report',
                targetId: { in: reportIds },
              },
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve([]),
      ]);

    const reporterById = new Map(reporters.map((u) => [u.id, u]));
    const messageById = new Map(messageTargets.map((m) => [m.id, m]));
    const attachmentById = new Map(attachmentTargets.map((a) => [a.id, a]));
    const profileById = new Map(profileTargets.map((u) => [u.id, u]));

    // Look up display names for any author / uploader behind a target.
    const additionalUserIds = new Set<string>();
    for (const m of messageTargets) if (m.authorId) additionalUserIds.add(m.authorId);
    for (const a of attachmentTargets) if (a.uploaderId) additionalUserIds.add(a.uploaderId);
    const additionalUsers = additionalUserIds.size
      ? await prisma.user.findMany({
          where: { id: { in: Array.from(additionalUserIds) } },
          select: { id: true, displayName: true },
        })
      : [];
    const userById = new Map(additionalUsers.map((u) => [u.id, u]));

    const eventsByReport = new Map<string, Array<{ at: string; kind: string; message: string }>>();
    for (const a of auditRows) {
      if (!a.targetId) continue;
      const arr = eventsByReport.get(a.targetId) ?? [];
      arr.push({
        at: a.createdAt.toISOString(),
        kind: a.action,
        message: formatReportAuditAction(a.action),
      });
      eventsByReport.set(a.targetId, arr);
    }

    reply.send(
      ok(
        reports.map((r) => {
          const base = serializeReport(r as ReportRow);
          const reporter = reporterById.get(r.reporterId);
          let targetUserId: string | null = null;
          let targetUserDisplayName: string | null = null;
          let targetPreview: string | null = null;

          if (r.targetType === 'message') {
            const m = messageById.get(r.targetId);
            if (m) {
              targetUserId = m.authorId;
              targetUserDisplayName = userById.get(m.authorId)?.displayName ?? null;
              targetPreview = m.content ? m.content.slice(0, 200) : null;
            }
          } else if (r.targetType === 'attachment') {
            const a = attachmentById.get(r.targetId);
            if (a) {
              targetUserId = a.uploaderId;
              targetUserDisplayName = userById.get(a.uploaderId)?.displayName ?? null;
              targetPreview = a.filename ?? null;
            }
          } else if (r.targetType === 'profile') {
            const p = profileById.get(r.targetId);
            if (p) {
              targetUserId = p.id;
              targetUserDisplayName = p.displayName;
            }
          }

          const events = eventsByReport.get(r.id) ?? [];
          // Always anchor the timeline with the original report creation.
          events.unshift({
            at: r.createdAt.toISOString(),
            kind: 'report.opened',
            message: 'Report opened.',
          });

          return {
            ...base,
            reporterDisplayName: reporter?.displayName ?? null,
            targetUserId,
            targetUserDisplayName,
            targetPreview,
            events,
          };
        }),
      ),
    );
  });

  app.get('/api/servers/:serverId/moderation/stats', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_MODERATION_QUEUE);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [openReports, inReview, newToday, oldest] = await Promise.all([
      prisma.report.count({ where: { serverId, status: { in: ['open', 'in_review'] } } }),
      prisma.report.count({ where: { serverId, status: 'in_review' } }),
      prisma.report.count({ where: { serverId, createdAt: { gte: dayAgo } } }),
      prisma.report.findFirst({
        where: { serverId, status: { in: ['open', 'in_review'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    reply.send(
      ok({
        openReports,
        inReview,
        newToday,
        oldestUnreviewedAt: oldest?.createdAt.toISOString() ?? null,
      }),
    );
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
    // Hydrate actor display name / username in a single follow-up query so the
    // UI doesn't have to render bare ULIDs. Cheap join given the 200-row cap.
    const actorIds = Array.from(
      new Set(entries.map((e) => e.actorId).filter((id): id is string => !!id)),
    );
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true, username: true },
        })
      : [];
    const actorById = new Map(actors.map((u) => [u.id, u]));
    reply.send(
      ok(
        entries.map((e) => {
          const actor = e.actorId ? actorById.get(e.actorId) : null;
          return {
            id: e.id,
            serverId: e.serverId,
            actorId: e.actorId,
            actorDisplayName: actor?.displayName ?? null,
            actorUsername: actor?.username ?? null,
            action: e.action,
            targetType: e.targetType,
            targetId: e.targetId,
            metadata: e.metadata ?? null,
            createdAt: e.createdAt.toISOString(),
          };
        }),
      ),
    );
  });
}
