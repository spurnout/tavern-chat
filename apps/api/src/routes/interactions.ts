/**
 * Message component interactions (parity gap #2).
 *
 * POST /api/messages/:id/interactions — a member presses a button or submits a
 * select on a message's components. Security boundary:
 *   - press requires VIEW_CHANNEL on the message's channel (DM: membership),
 *     exactly like poll voting;
 *   - the customId must exist on the message's components;
 *   - link buttons are rejected (no server-side callback);
 *   - per-user rate limit via the MessageInteraction table;
 *   - built-in handlers re-check their own permissions.
 *
 * Self-hosted-friendly: there is no external app/OAuth registry. Interactions
 * dispatch to in-process built-in handlers keyed by a customId prefix. The
 * first shipped handler is `builtin:role-toggle:<roleId>` (self-assign role).
 * Unknown customIds are recorded + acknowledged so webhook-authored buttons
 * don't error.
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  actionRowSchema,
  idSchema,
  interactionExecuteSchema,
  Permission,
  TavernError,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { requireDmChannelMembership } from '../services/dm-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

// Per-user interaction rate limit: at most N presses per window.
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10_000;

/** Flatten the message's stored action rows to a customId → component map. */
function findComponent(
  componentsJson: unknown,
  customId: string,
): { kind: 'button' | 'select'; isLink: boolean } | null {
  const rows = z.array(actionRowSchema).safeParse(componentsJson ?? []);
  if (!rows.success) return null;
  for (const row of rows.data) {
    for (const c of row.components) {
      if (c.type === 'button' && c.style !== 'link' && c.customId === customId) {
        return { kind: 'button', isLink: false };
      }
      if (c.type === 'button' && c.style === 'link') {
        // Link buttons have no customId; never match.
        continue;
      }
      if (c.type === 'select' && c.customId === customId) {
        return { kind: 'select', isLink: false };
      }
    }
  }
  return null;
}

export async function registerInteractionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/messages/:id/interactions', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const body = interactionExecuteSchema.parse(req.body);

      const message = await prisma.message.findUnique({
        where: { id },
        select: {
          serverId: true,
          channelId: true,
          dmChannelId: true,
          deletedAt: true,
          componentsJson: true,
        },
      });
      if (!message || message.deletedAt) throw TavernError.notFound();

      // Who can press — same gate as reading the message.
      if (message.dmChannelId) {
        await requireDmChannelMembership(message.dmChannelId, ctx.userId);
      } else if (message.channelId) {
        await requireChannelPermission(message.channelId, ctx.userId, Permission.VIEW_CHANNEL);
      } else {
        throw TavernError.notFound();
      }

      const component = findComponent(message.componentsJson, body.customId);
      if (!component) {
        throw TavernError.validation('No such interactive component on this message');
      }

      // Per-user rate limit (durable, multi-replica-safe).
      const since = new Date(Date.now() - RATE_WINDOW_MS);
      const recent = await prisma.messageInteraction.count({
        where: { userId: ctx.userId, createdAt: { gte: since } },
      });
      if (recent >= RATE_MAX) {
        throw new TavernError('SLOWMODE_ACTIVE', 'Slow down — too many interactions', 429);
      }

      await prisma.messageInteraction.create({
        data: {
          id: ulid(),
          messageId: id,
          userId: ctx.userId,
          componentId: body.customId,
          values: body.values as object,
        },
      });

      // Dispatch. Built-in handlers are keyed by a `builtin:<name>:<arg>` prefix.
      let responseContent = 'Done';
      if (body.customId.startsWith('builtin:role-toggle:') && message.serverId) {
        responseContent = await handleRoleToggle(
          message.serverId,
          ctx.userId,
          body.customId.slice('builtin:role-toggle:'.length),
        );
      } else {
        responseContent = 'Noted';
      }

      // Ephemeral ack to the presser only.
      gatewayBroker.publish({
        type: 'INTERACTION_RESPONSE',
        userId: ctx.userId,
        data: { messageId: id, customId: body.customId, kind: 'ephemeral', content: responseContent },
      });

      reply.send(ok({ ok: true, content: responseContent }));
    },
  });
}

/**
 * Built-in self-assign role toggle. Only roles flagged `mentionable` are
 * self-assignable (a lightweight, operator-controlled allowlist that needs no
 * extra schema). The presser must be a member of the role's tavern.
 */
async function handleRoleToggle(
  serverId: string,
  userId: string,
  roleId: string,
): Promise<string> {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    select: { id: true, serverId: true, name: true, mentionable: true, isEveryone: true },
  });
  if (!role || role.serverId !== serverId || role.isEveryone) {
    throw TavernError.validation('That role is not self-assignable');
  }
  if (!role.mentionable) {
    throw TavernError.forbidden('That role is not self-assignable');
  }
  const member = await prisma.serverMember.findUnique({
    where: { serverId_userId: { serverId, userId } },
    select: { userId: true },
  });
  if (!member) throw TavernError.forbidden('Not a member of this tavern');

  const existing = await prisma.serverMemberRole.findUnique({
    where: { serverId_userId_roleId: { serverId, userId, roleId } },
    select: { roleId: true },
  });
  if (existing) {
    await prisma.serverMemberRole.delete({
      where: { serverId_userId_roleId: { serverId, userId, roleId } },
    });
  } else {
    await prisma.serverMemberRole.create({ data: { serverId, userId, roleId } });
  }

  // Reflect the role change to the member's sidebar / profile cards.
  const updated = await prisma.serverMemberRole.findMany({
    where: { serverId, userId },
    select: { roleId: true },
  });
  gatewayBroker.publish({
    type: 'MEMBER_UPDATE',
    serverId,
    userId,
    data: { serverId, userId, roles: updated.map((r) => r.roleId) },
  });

  return existing ? `Removed ${role.name}` : `Added ${role.name}`;
}
