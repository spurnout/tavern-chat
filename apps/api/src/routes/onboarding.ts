/**
 * Member onboarding / welcome-screen routes (parity gap #3).
 *
 * Builds on the JoinGate primitive: JoinGate stays the mod-reviewed screening
 * queue; onboarding adds a self-serve welcome screen + opt-in role picker.
 * Both share ServerMember.gatePassedAt as the single "cleared to post" flag,
 * and JoinGate.rulesMd is the rules source of truth.
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  Permission,
  serverOnboardingSchema,
  submitOnboardingChoicesSchema,
  TavernError,
  ulid,
  upsertOnboardingPromptsSchema,
  upsertOnboardingSchema,
  type RecommendedRoom,
  type ServerOnboarding,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { postSystemMessage } from '../services/system-message-service.js';

/** Parse the recommendedRoomsJson blob into the validated DTO shape, dropping
 *  malformed entries (tolerant of dangling channel ids — those are filtered on
 *  the client when they no longer resolve). */
function parseRecommendedRooms(raw: unknown): RecommendedRoom[] {
  if (!Array.isArray(raw)) return [];
  const out: RecommendedRoom[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { channelId?: unknown }).channelId === 'string'
    ) {
      out.push({
        channelId: (item as { channelId: string }).channelId,
        description: String((item as { description?: unknown }).description ?? ''),
      });
    }
  }
  return out;
}

function parseChannelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  // Full onboarding payload — config + prompts + options + rules, one fetch.
  app.get('/api/servers/:id/onboarding', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);

    const [onboarding, gate, prompts] = await Promise.all([
      prisma.serverOnboarding.findUnique({ where: { serverId } }),
      prisma.joinGate.findUnique({ where: { serverId }, select: { rulesMd: true } }),
      prisma.onboardingPrompt.findMany({
        where: { serverId },
        orderBy: { position: 'asc' },
        include: { options: { orderBy: { position: 'asc' } } },
      }),
    ]);

    const dto: ServerOnboarding = {
      serverId,
      enabled: onboarding?.enabled ?? false,
      welcomeText: onboarding?.welcomeText ?? '',
      recommendedRooms: parseRecommendedRooms(onboarding?.recommendedRoomsJson),
      requireRules: onboarding?.requireRules ?? false,
      rulesMd: gate?.rulesMd ?? '',
      prompts: prompts.map((p) => ({
        id: p.id,
        title: p.title,
        multiSelect: p.multiSelect,
        position: p.position,
        options: p.options.map((o) => ({
          id: o.id,
          label: o.label,
          roleId: o.roleId,
          channelIds: parseChannelIds(o.channelIdsJson),
          position: o.position,
        })),
      })),
    };
    reply.send(ok(serverOnboardingSchema.parse(dto)));
  });

  // Upsert config (welcome text, recommended rooms, requireRules, enabled).
  app.put('/api/servers/:id/onboarding', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = upsertOnboardingSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER);

    await prisma.serverOnboarding.upsert({
      where: { serverId },
      create: {
        serverId,
        enabled: body.enabled,
        welcomeText: body.welcomeText,
        recommendedRoomsJson: body.recommendedRooms as object,
        requireRules: body.requireRules,
      },
      update: {
        enabled: body.enabled,
        welcomeText: body.welcomeText,
        recommendedRoomsJson: body.recommendedRooms as object,
        requireRules: body.requireRules,
      },
    });
    reply.send(ok({ ok: true }));
  });

  // Replace-all prompts + options.
  app.put('/api/servers/:id/onboarding/prompts', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = upsertOnboardingPromptsSchema.parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER);

    // Onboarding config must exist for prompts to FK against it.
    await prisma.serverOnboarding.upsert({
      where: { serverId },
      create: { serverId },
      update: {},
    });

    await prisma.$transaction(async (tx) => {
      // Cascade deletes options.
      await tx.onboardingPrompt.deleteMany({ where: { serverId } });
      for (const [pIdx, p] of body.prompts.entries()) {
        const promptId = ulid();
        await tx.onboardingPrompt.create({
          data: {
            id: promptId,
            serverId,
            title: p.title,
            multiSelect: p.multiSelect,
            position: pIdx,
          },
        });
        await tx.onboardingPromptOption.createMany({
          data: p.options.map((o, oIdx) => ({
            id: ulid(),
            promptId,
            label: o.label,
            roleId: o.roleId,
            channelIdsJson: o.channelIds as object,
            position: oIdx,
          })),
        });
      }
    });
    reply.send(ok({ ok: true }));
  });

  // Member self-serve completion: accept rules + pick options → roles granted.
  app.post('/api/servers/:id/onboarding/complete', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = submitOnboardingChoicesSchema.parse(req.body);

    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: ctx.userId } },
      select: { gatePassedAt: true },
    });
    if (!member) throw TavernError.forbidden('Not a member of this tavern');

    const onboarding = await prisma.serverOnboarding.findUnique({ where: { serverId } });

    // Resolve the chosen options to roles. Only options that belong to this
    // tavern's prompts are honoured (ignore anything spoofed in the body).
    const chosenOptionIds = Object.values(body.selections).flat();
    const validOptions =
      chosenOptionIds.length > 0
        ? await prisma.onboardingPromptOption.findMany({
            where: { id: { in: chosenOptionIds }, prompt: { serverId } },
            select: { roleId: true },
          })
        : [];
    const roleIds = Array.from(
      new Set(validOptions.map((o) => o.roleId).filter((r): r is string => r !== null)),
    );

    await prisma.$transaction(async (tx) => {
      if (onboarding?.requireRules && body.acceptedRules && member.gatePassedAt === null) {
        await tx.serverMember.update({
          where: { serverId_userId: { serverId, userId: ctx.userId } },
          data: { gatePassedAt: new Date() },
        });
      }
      if (roleIds.length > 0) {
        await tx.serverMemberRole.createMany({
          data: roleIds.map((roleId) => ({ serverId, userId: ctx.userId, roleId })),
          skipDuplicates: true,
        });
      }
    });

    // Reflect the new roles to the member's sidebar / open profile cards.
    if (roleIds.length > 0) {
      const updated = await prisma.serverMemberRole.findMany({
        where: { serverId, userId: ctx.userId },
        select: { roleId: true },
      });
      gatewayBroker.publish({
        type: 'MEMBER_UPDATE',
        serverId,
        userId: ctx.userId,
        data: { serverId, userId: ctx.userId, roles: updated.map((r) => r.roleId) },
      });
    }

    // Best-effort welcome system message.
    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: { systemChannelId: true },
    });
    if (server?.systemChannelId) {
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true },
      });
      if (user) {
        void postSystemMessage(
          serverId,
          server.systemChannelId,
          `**${user.displayName}** pulled up a chair`,
        ).catch(() => undefined);
      }
    }

    reply.send(ok({ ok: true }));
  });
}
