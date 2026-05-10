import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createHandoutRequestSchema,
  idSchema,
  Permission,
  TavernError,
  ulid,
  updateHandoutRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';

interface HandoutRow {
  id: string;
  campaignId: string;
  serverId: string;
  authorId: string;
  title: string;
  body: string;
  visibility: string;
  attachmentIds: string[];
  createdAt: Date;
  updatedAt: Date;
  visibleUsers?: { userId: string }[];
}

function serialize(h: HandoutRow) {
  return {
    id: h.id,
    campaignId: h.campaignId,
    serverId: h.serverId,
    authorId: h.authorId,
    title: h.title,
    body: h.body,
    attachmentIds: h.attachmentIds,
    visibility: h.visibility as 'public_to_party' | 'gm_only' | 'specific_players',
    visibleToUserIds: (h.visibleUsers ?? []).map((v) => v.userId),
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

export async function registerHandoutRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/handouts', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound();
    const perms = await getServerPermissions(c.serverId, ctx.userId);
    if (perms === 0n) throw TavernError.notFound();
    const isGm = c.gmUserId === ctx.userId;
    const canSeePrivate =
      isGm ||
      (perms & Permission.VIEW_PRIVATE_HANDOUTS) === Permission.VIEW_PRIVATE_HANDOUTS ||
      (perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;

    const rows = await prisma.handout.findMany({
      where: { campaignId: id },
      include: { visibleUsers: true },
      orderBy: { updatedAt: 'desc' },
    });

    const visible = rows.filter((h) => {
      if (canSeePrivate) return true;
      if (h.visibility === 'public_to_party') return true;
      if (h.visibility === 'specific_players') {
        return h.visibleUsers.some((v) => v.userId === ctx.userId);
      }
      return false;
    });
    reply.send(ok(visible.map((h) => serialize(h as HandoutRow))));
  });

  app.post('/api/handouts', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createHandoutRequestSchema.parse(req.body);
    const c = await prisma.campaign.findUnique({ where: { id: body.campaignId } });
    if (!c) throw TavernError.notFound();
    if (c.gmUserId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.MANAGE_HANDOUTS);
    }

    const id = ulid();
    const created = await prisma.$transaction(async (tx) => {
      await tx.handout.create({
        data: {
          id,
          campaignId: c.id,
          serverId: c.serverId,
          authorId: ctx.userId,
          title: body.title,
          body: body.body,
          visibility: body.visibility,
          attachmentIds: body.attachmentIds ?? [],
        },
      });
      if (body.visibleToUserIds?.length) {
        await tx.handoutVisibleUser.createMany({
          data: body.visibleToUserIds.map((userId) => ({ handoutId: id, userId })),
        });
      }
      return tx.handout.findUnique({ where: { id }, include: { visibleUsers: true } });
    });
    reply.status(201).send(ok(serialize(created as unknown as HandoutRow)));
  });

  app.patch('/api/handouts/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateHandoutRequestSchema.parse(req.body);
    const h = await prisma.handout.findUnique({ where: { id } });
    if (!h) throw TavernError.notFound();
    const c = await prisma.campaign.findUnique({ where: { id: h.campaignId } });
    if (!c) throw TavernError.notFound();
    if (c.gmUserId !== ctx.userId && h.authorId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.MANAGE_HANDOUTS);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.handout.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
          ...(body.attachmentIds !== undefined ? { attachmentIds: body.attachmentIds } : {}),
        },
      });
      if (body.visibleToUserIds !== undefined) {
        await tx.handoutVisibleUser.deleteMany({ where: { handoutId: id } });
        if (body.visibleToUserIds.length > 0) {
          await tx.handoutVisibleUser.createMany({
            data: body.visibleToUserIds.map((userId) => ({ handoutId: id, userId })),
          });
        }
      }
      return tx.handout.findUnique({ where: { id }, include: { visibleUsers: true } });
    });
    reply.send(ok(serialize(updated as unknown as HandoutRow)));
  });
}
