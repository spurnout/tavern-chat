import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import {
  createInviteRequestSchema,
  idSchema,
  Permission,
  TavernError,
  TOKEN_TTL,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

function serializeInvite(i: {
  id: string;
  code: string;
  scope: string;
  serverId: string | null;
  channelId: string | null;
  createdById: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: i.id,
    code: i.code,
    scope: i.scope as 'instance' | 'server',
    serverId: i.serverId,
    channelId: i.channelId,
    createdById: i.createdById,
    maxUses: i.maxUses,
    uses: i.uses,
    expiresAt: i.expiresAt?.toISOString() ?? null,
    revokedAt: i.revokedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

function generateInviteCode(): string {
  const buf = randomBytes(8);
  return buf.toString('base64url').toUpperCase().slice(0, 10);
}

export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/invites', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createInviteRequestSchema.parse(req.body);

    if (body.scope === 'server') {
      if (!body.serverId) throw TavernError.validation('serverId required for server scope');
      await requireServerPermission(body.serverId, ctx.userId, Permission.CREATE_INVITES);
    } else {
      // Instance invites require instance admin.
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { isInstanceAdmin: true },
      });
      if (!me?.isInstanceAdmin) throw TavernError.forbidden();
    }

    const invite = await prisma.invite.create({
      data: {
        id: ulid(),
        code: generateInviteCode(),
        scope: body.scope,
        serverId: body.serverId ?? null,
        channelId: body.channelId ?? null,
        createdById: ctx.userId,
        maxUses: body.maxUses ?? null,
        expiresAt: body.expiresInSeconds
          ? new Date(Date.now() + body.expiresInSeconds * 1000)
          : new Date(Date.now() + TOKEN_TTL.INVITE_SECONDS * 1000),
      },
    });

    await writeAuditEntry({
      serverId: body.serverId ?? null,
      actorId: ctx.userId,
      action: 'invite.created',
      targetType: 'invite',
      targetId: invite.id,
      metadata: { scope: invite.scope },
    });
    if (invite.serverId) {
      gatewayBroker.publish({
        type: 'INVITE_CREATE',
        serverId: invite.serverId,
        data: serializeInvite(invite),
      });
    }
    reply.status(201).send(ok(serializeInvite(invite)));
  });

  app.delete('/api/invites/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const invite = await prisma.invite.findUnique({ where: { id } });
    if (!invite) throw TavernError.notFound();
    if (invite.serverId) {
      await requireServerPermission(invite.serverId, ctx.userId, Permission.MANAGE_SERVER);
    } else {
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { isInstanceAdmin: true },
      });
      if (!me?.isInstanceAdmin) throw TavernError.forbidden();
    }
    await prisma.invite.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await writeAuditEntry({
      serverId: invite.serverId,
      actorId: ctx.userId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: id,
    });
    reply.send(ok({ id }));
  });

  // Use an invite to join a server.
  app.post('/api/invites/:code/join', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { code } = z.object({ code: z.string().min(4).max(64) }).parse(req.params);
    const invite = await prisma.invite.findUnique({ where: { code } });
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt < new Date())) {
      throw new TavernError('INVALID_INVITE', 'Invite is invalid or expired', 400);
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw new TavernError('INVALID_INVITE', 'Invite has been fully used', 400);
    }
    if (invite.scope !== 'server' || !invite.serverId) {
      throw TavernError.validation('Invite is not server-scoped');
    }

    const existing = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: invite.serverId, userId: ctx.userId } },
    });
    if (!existing) {
      await prisma.serverMember.create({
        data: { serverId: invite.serverId, userId: ctx.userId },
      });
      await prisma.invite.update({
        where: { id: invite.id },
        data: { uses: { increment: 1 } },
      });
      gatewayBroker.publish({
        type: 'MEMBER_ADD',
        serverId: invite.serverId,
        data: { serverId: invite.serverId, userId: ctx.userId },
      });
    }
    reply.send(ok({ serverId: invite.serverId }));
  });
}
