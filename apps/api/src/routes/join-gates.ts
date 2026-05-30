import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';

const upsertGate = z.object({
  rulesMd: z.string().max(8000).default(''),
  questionsJson: z
    .array(z.object({ id: z.string().max(60), label: z.string().max(280), required: z.boolean().default(true) }))
    .default([]),
  enabled: z.boolean().default(false),
});

const submitAnswerSchema = z.object({
  answersJson: z.record(z.string()),
});

const reviewSchema = z.object({
  approved: z.boolean(),
});

/**
 * Wave 3 #17 — Verification gating on join. Server can require new members
 * to accept rules + answer N questions before they get full posting rights.
 * Mods review pending answers via the moderation page.
 */
export async function registerJoinGateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/join-gate', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const gate = await prisma.joinGate.findUnique({ where: { serverId } });
    reply.send(ok(gate));
  });

  app.put('/api/servers/:id/join-gate', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = upsertGate.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER_SAFETY_POLICY);
    const gate = await prisma.joinGate.upsert({
      where: { serverId },
      create: {
        serverId,
        rulesMd: body.rulesMd,
        questionsJson: body.questionsJson as object,
        enabled: body.enabled,
      },
      update: {
        rulesMd: body.rulesMd,
        questionsJson: body.questionsJson as object,
        enabled: body.enabled,
      },
    });
    reply.send(ok(gate));
  });

  app.post('/api/servers/:id/join-gate/answers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = submitAnswerSchema.parse(req.body);
    // Caller must be a member (so they joined via invite) but gate-pass status
    // is checked separately.
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: ctx.userId } },
    });
    if (!member) throw TavernError.forbidden('Not a member of this tavern');
    const answer = await prisma.joinGateAnswer.upsert({
      where: { serverId_userId: { serverId, userId: ctx.userId } },
      create: {
        serverId,
        userId: ctx.userId,
        answersJson: body.answersJson as object,
      },
      update: {
        answersJson: body.answersJson as object,
        submittedAt: new Date(),
        reviewedAt: null,
        reviewedBy: null,
        approved: false,
      },
    });
    reply.status(201).send(ok(answer));
  });

  app.get('/api/servers/:id/join-gate/pending', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_MESSAGES);
    const rows = await prisma.joinGateAnswer.findMany({
      where: { serverId, reviewedAt: null },
      orderBy: { submittedAt: 'asc' },
      include: { user: { select: { id: true, displayName: true, username: true } } },
    });
    reply.send(ok(rows));
  });

  app.post('/api/servers/:id/join-gate/review/:userId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId, userId } = z
      .object({ id: idSchema, userId: idSchema })
      .parse(req.params);
    const body = reviewSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_MESSAGES);

    // Without this guard, tx.joinGateAnswer.update on a missing row throws
    // Prisma P2025, which the global handler maps to 500. Return 404 instead.
    const existing = await prisma.joinGateAnswer.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (!existing) throw TavernError.notFound('No pending answer for this user');

    await prisma.$transaction(async (tx) => {
      await tx.joinGateAnswer.update({
        where: { serverId_userId: { serverId, userId } },
        data: { reviewedAt: new Date(), reviewedBy: ctx.userId, approved: body.approved },
      });
      if (body.approved) {
        await tx.serverMember.update({
          where: { serverId_userId: { serverId, userId } },
          data: { gatePassedAt: new Date() },
        });
      }
    });
    reply.send(ok({ userId, approved: body.approved }));
  });
}
