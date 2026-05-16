import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { getServerPermissions } from '../services/permissions-service.js';

const KINDS = ['line', 'veil', 'star', 'wish', 'note'] as const;

const createBodySchema = z.object({
  kind: z.enum(KINDS),
  content: z.string().min(1).max(2000),
  isPrivate: z.boolean().optional(),
});

/**
 * Wave 3 #23 — Safety tools panel.
 *
 * Lines, veils, stars, wishes, and free-form notes scoped to a single
 * campaign. The GM-level rules (off-limits topics) already live as
 * `Campaign.safetyBoundariesJson`; this is the collaborative surface
 * everyone at the table contributes to.
 *
 * Visibility rules on read:
 *   - GM (or VIEW_GM_NOTES / ADMINISTRATOR holders) see every entry.
 *   - Other members see all non-private entries plus their own.
 *
 * Anyone with server access can create entries for themselves; deletion
 * is the GM or the author.
 */
export async function registerCampaignSafetyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns/:id/safety', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound('Campaign not found');
    const perms = await getServerPermissions(c.serverId, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Campaign not found');
    const isPriviledged =
      c.gmUserId === ctx.userId ||
      (perms & Permission.VIEW_GM_NOTES) === Permission.VIEW_GM_NOTES ||
      (perms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;

    const rows = await prisma.campaignSafetyEntry.findMany({
      where: isPriviledged
        ? { campaignId: id }
        : {
            campaignId: id,
            OR: [{ isPrivate: false }, { authorId: ctx.userId }],
          },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(
      ok(
        rows.map((r) => ({
          id: r.id,
          campaignId: r.campaignId,
          authorId: r.authorId,
          kind: r.kind,
          content: r.content,
          isPrivate: r.isPrivate,
          createdAt: r.createdAt.toISOString(),
        })),
      ),
    );
  });

  app.post('/api/campaigns/:id/safety', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const body = createBodySchema.parse(req.body);
      const c = await prisma.campaign.findUnique({ where: { id } });
      if (!c) throw TavernError.notFound('Campaign not found');
      const perms = await getServerPermissions(c.serverId, ctx.userId);
      if (perms === 0n) throw TavernError.notFound('Campaign not found');
      const row = await prisma.campaignSafetyEntry.create({
        data: {
          id: ulid(),
          campaignId: id,
          authorId: ctx.userId,
          kind: body.kind,
          content: body.content,
          isPrivate: body.isPrivate ?? false,
        },
      });
      reply.status(201).send(
        ok({
          id: row.id,
          campaignId: row.campaignId,
          authorId: row.authorId,
          kind: row.kind,
          content: row.content,
          isPrivate: row.isPrivate,
          createdAt: row.createdAt.toISOString(),
        }),
      );
    },
  });

  app.delete('/api/safety-entries/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.campaignSafetyEntry.findUnique({
      where: { id },
      include: { campaign: { select: { gmUserId: true, serverId: true } } },
    });
    if (!row) throw TavernError.notFound('Entry not found');
    const isAuthor = row.authorId === ctx.userId;
    const isGm = row.campaign.gmUserId === ctx.userId;
    if (!isAuthor && !isGm) {
      // Instance admins still pass — they always have ADMINISTRATOR via
      // server perms — but the cheap check above covers 99% of real calls.
      const perms = await getServerPermissions(row.campaign.serverId, ctx.userId);
      if ((perms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR) {
        throw TavernError.forbidden('Only the author or the GM can remove this');
      }
    }
    await prisma.campaignSafetyEntry.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
