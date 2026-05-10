import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createNoteRequestSchema,
  idSchema,
  Permission,
  TavernError,
  ulid,
  updateNoteRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';

interface NoteRow {
  id: string;
  campaignId: string;
  serverId: string;
  authorId: string;
  title: string;
  body: string;
  visibility: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(n: NoteRow) {
  return {
    id: n.id,
    campaignId: n.campaignId,
    serverId: n.serverId,
    authorId: n.authorId,
    title: n.title,
    body: n.body,
    visibility: n.visibility as 'public_to_party' | 'gm_only',
    pinned: n.pinned,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/notes', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound();
    const perms = await getServerPermissions(c.serverId, ctx.userId);
    if (perms === 0n) throw TavernError.notFound();
    const isGm = c.gmUserId === ctx.userId;
    const canSeeGm =
      isGm ||
      (perms & Permission.VIEW_GM_NOTES) === Permission.VIEW_GM_NOTES ||
      (perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;

    const where = canSeeGm ? { campaignId: id } : { campaignId: id, visibility: 'public_to_party' as const };
    const rows = await prisma.campaignNote.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
    });
    reply.send(ok(rows.map((r) => serialize(r as NoteRow))));
  });

  app.post('/api/notes', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createNoteRequestSchema.parse(req.body);
    const c = await prisma.campaign.findUnique({ where: { id: body.campaignId } });
    if (!c) throw TavernError.notFound();
    if (c.gmUserId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.MANAGE_CAMPAIGN_NOTES);
    }
    const created = await prisma.campaignNote.create({
      data: {
        id: ulid(),
        campaignId: c.id,
        serverId: c.serverId,
        authorId: ctx.userId,
        title: body.title,
        body: body.body,
        visibility: body.visibility,
        pinned: body.pinned ?? false,
      },
    });
    reply.status(201).send(ok(serialize(created as NoteRow)));
  });

  app.patch('/api/notes/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateNoteRequestSchema.parse(req.body);
    const note = await prisma.campaignNote.findUnique({ where: { id } });
    if (!note) throw TavernError.notFound();
    const c = await prisma.campaign.findUnique({ where: { id: note.campaignId } });
    if (!c) throw TavernError.notFound();
    if (note.authorId !== ctx.userId && c.gmUserId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.MANAGE_CAMPAIGN_NOTES);
    }
    const updated = await prisma.campaignNote.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      },
    });
    reply.send(ok(serialize(updated as NoteRow)));
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const note = await prisma.campaignNote.findUnique({ where: { id } });
    if (!note) throw TavernError.notFound();
    const c = await prisma.campaign.findUnique({ where: { id: note.campaignId } });
    if (!c) throw TavernError.notFound();
    if (note.authorId !== ctx.userId && c.gmUserId !== ctx.userId) {
      await requireServerPermission(c.serverId, ctx.userId, Permission.MANAGE_CAMPAIGN_NOTES);
    }
    await prisma.campaignNote.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
