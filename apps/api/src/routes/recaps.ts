import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import type { RecapService } from '../services/recap-service.js';

interface RecapRouteOpts {
  recap: RecapService;
}

const generateBodySchema = z.object({
  /** Optional CampaignSession to associate the recap with. */
  sessionId: idSchema.optional(),
  /**
   * Plain-text transcript. If omitted, the route will try to compose one
   * from the session's existing `recap` + recent messages — but operators
   * who use a different recording flow should pass the text directly.
   */
  transcript: z.string().min(20).max(60_000).optional(),
  /** Extra prompt fragment (tone, focus, etc.) appended as a system message. */
  extraGuidance: z.string().max(500).optional(),
});

/**
 * Wave 3 #48 — AI session recaps.
 *
 * The GM (or anyone with VIEW_GM_NOTES / ADMINISTRATOR) hits POST with a
 * transcript; the recap-service POSTs it to the operator's configured
 * OpenAI-compatible endpoint and stores the response. The result is
 * editable — the route returns the body so the GM can refine before
 * persisting via PATCH /api/recaps/:id. (V1: ship raw model output;
 * editing is the client's job via PATCH.)
 */
export async function registerRecapRoutes(
  app: FastifyInstance,
  opts: RecapRouteOpts,
): Promise<void> {
  app.get('/api/campaigns/:id/recaps', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound('Campaign not found');
    const perms = await getServerPermissions(c.serverId, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Campaign not found');
    const rows = await prisma.sessionRecap.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(ok(rows.map(serialize)));
  });

  app.post('/api/campaigns/:id/recaps', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const body = generateBodySchema.parse(req.body);
      const c = await prisma.campaign.findUnique({ where: { id } });
      if (!c) throw TavernError.notFound('Campaign not found');
      // Recap generation is a GM-only / privileged action — it sends data
      // through an external service and creates persistent records, so
      // gate on VIEW_GM_NOTES (or the user being the GM, or ADMIN).
      if (c.gmUserId !== ctx.userId) {
        await requireServerPermission(c.serverId, ctx.userId, Permission.VIEW_GM_NOTES);
      }

      if (!opts.recap.isEnabled()) {
        throw new TavernError(
          'INTERNAL_ERROR',
          'AI recap is not configured on this instance. Set LLM_ENDPOINT to enable.',
          503,
        );
      }

      // Resolve the transcript: explicit body wins; else compose from the
      // session's existing recap field + the session's text channel last N
      // messages (capped at 200) as a basic substrate.
      let transcript = body.transcript;
      if (!transcript && body.sessionId) {
        const session = await prisma.campaignSession.findUnique({
          where: { id: body.sessionId },
          select: {
            id: true,
            title: true,
            recap: true,
            textChannelId: true,
            scheduledStart: true,
          },
        });
        if (!session || session.id !== body.sessionId) {
          throw TavernError.notFound('Session not found');
        }
        const fragments: string[] = [];
        if (session.title) fragments.push(`Session: ${session.title}`);
        if (session.recap) fragments.push(`Prior notes: ${session.recap}`);
        if (session.textChannelId) {
          const recent = await prisma.message.findMany({
            where: { channelId: session.textChannelId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            take: 200,
            select: {
              author: { select: { displayName: true, username: true } },
              content: true,
            },
          });
          if (recent.length > 0) {
            fragments.push('---');
            for (const m of recent) {
              const who = m.author?.displayName ?? m.author?.username ?? 'someone';
              fragments.push(`${who}: ${m.content}`);
            }
          }
        }
        transcript = fragments.join('\n');
      }

      if (!transcript || transcript.trim().length < 20) {
        throw TavernError.validation(
          'Provide a transcript or link a sessionId with channel history.',
        );
      }

      const result = await opts.recap.generate(transcript, {
        ...(body.extraGuidance ? { extraGuidance: body.extraGuidance } : {}),
      });

      const row = await prisma.sessionRecap.create({
        data: {
          id: ulid(),
          campaignId: id,
          sessionId: body.sessionId ?? null,
          body: result.body,
          modelUsed: result.modelUsed,
          generatedBy: ctx.userId,
        },
      });
      reply.status(201).send(ok(serialize(row)));
    },
  });

  app.patch('/api/recaps/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z.object({ body: z.string().min(1).max(20_000) }).parse(req.body);
    const row = await prisma.sessionRecap.findUnique({
      where: { id },
      include: { campaign: { select: { gmUserId: true, serverId: true } } },
    });
    if (!row) throw TavernError.notFound('Recap not found');
    if (row.generatedBy !== ctx.userId && row.campaign.gmUserId !== ctx.userId) {
      await requireServerPermission(row.campaign.serverId, ctx.userId, Permission.VIEW_GM_NOTES);
    }
    const updated = await prisma.sessionRecap.update({
      where: { id },
      data: { body: body.body },
    });
    reply.send(ok(serialize(updated)));
  });

  app.delete('/api/recaps/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.sessionRecap.findUnique({
      where: { id },
      include: { campaign: { select: { gmUserId: true, serverId: true } } },
    });
    if (!row) throw TavernError.notFound('Recap not found');
    if (row.generatedBy !== ctx.userId && row.campaign.gmUserId !== ctx.userId) {
      await requireServerPermission(row.campaign.serverId, ctx.userId, Permission.VIEW_GM_NOTES);
    }
    await prisma.sessionRecap.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}

function serialize(row: {
  id: string;
  campaignId: string;
  sessionId: string | null;
  body: string;
  modelUsed: string;
  generatedBy: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    sessionId: row.sessionId,
    body: row.body,
    modelUsed: row.modelUsed,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
  };
}
