import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  createInviteRequestSchema,
  idSchema,
  Permission,
  TavernError,
  TOKEN_TTL,
  ulid,
  type RemoteInviteScope,
} from '@tavern/shared';
import { generateInviteCode } from '../lib/invite-codes.js';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { fanOutMemberAdd } from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';
import { isBanned } from '../services/ban-service.js';
import { postSystemMessage } from '../services/system-message-service.js';

// Federation Phase 4 — remote-user identity is `localpart@host`. The regex is
// intentionally duplicated from packages/shared/src/federation/{messages,
// membership}.ts where the federated wire schemas live; introducing a shared
// export touches the federation envelope surface and is deferred until a
// follow-up cleanup task. Keep the pattern identical to the federation copy
// so behaviour matches across the boundary.
const REMOTE_USER_ID_RE = /^[a-z0-9_.-]+@[a-z0-9.-]+\.[a-z0-9.-]+$/i;

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
  remoteScope: string | null;
  remoteInstanceHost: string | null;
  remoteUserId: string | null;
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
    remoteScope: i.remoteScope as RemoteInviteScope | null,
    remoteInstanceHost: i.remoteInstanceHost,
    remoteUserId: i.remoteUserId,
  };
}

export interface InviteRouteDeps {
  /**
   * Queue client for the P4-10 `member.add` fan-out on the local join
   * path. Optional — when omitted (or when `selfHost` is missing) the
   * fan-out hook short-circuits, mirroring the channel/server route deps.
   */
  queues?: QueueClient;
  /** This instance's federation host (e.g. `a.example`). */
  selfHost?: string | null;
  /**
   * Instance-level FEDERATION_ENABLED flag — threaded through to the
   * fan-out helper as defence-in-depth.
   */
  federationEnabledOnInstance?: boolean;
}

export async function registerInviteRoutes(
  app: FastifyInstance,
  deps?: InviteRouteDeps,
): Promise<void> {
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

    // Federation Phase 4 — federated-invite validation. The checks below run
    // ONLY when the caller opted into a remoteScope; local invites (the
    // dominant path) skip all of this so the existing creation flow is
    // unchanged.
    let remoteInstanceHost: string | null = null;
    let remoteUserId: string | null = null;
    if (body.remoteScope !== undefined) {
      // 1. Remote scope is meaningful only on server-scoped invites.
      if (body.scope !== 'server') {
        throw TavernError.validation('remote invites must be server-scoped');
      }
      // serverId is guaranteed non-null here because the earlier `scope ===
      // 'server'` branch threw if it was missing, but narrow for the
      // type-checker.
      if (!body.serverId) {
        throw TavernError.validation('remote invites must be server-scoped');
      }
      // 2. The target Tavern must have federation switched on. (Instance-level
      //    FEDERATION_ENABLED is already a precondition for setting this flag
      //    in the first place — P3-10 — so checking the Server row is enough.)
      const server = await prisma.server.findUnique({
        where: { id: body.serverId },
        select: { federationEnabled: true },
      });
      if (!server || server.federationEnabled === false) {
        throw TavernError.validation('server is not federation-enabled');
      }

      // 3. any_peer — the other two fields must be null/absent.
      if (body.remoteScope === 'any_peer') {
        if (body.remoteInstanceHost !== undefined || body.remoteUserId !== undefined) {
          throw TavernError.validation(
            'any_peer scope does not accept remoteInstanceHost or remoteUserId',
          );
        }
      }

      // 4–5. specific_instance — host required AND must be a peered instance.
      if (body.remoteScope === 'specific_instance') {
        if (!body.remoteInstanceHost) {
          throw TavernError.validation('specific_instance scope requires remoteInstanceHost');
        }
        const peer = await prisma.remoteInstance.findUnique({
          where: { host: body.remoteInstanceHost },
          select: { status: true },
        });
        if (!peer || peer.status !== 'peered') {
          throw TavernError.validation('remoteInstanceHost is not a peered instance');
        }
        remoteInstanceHost = body.remoteInstanceHost;
      }

      // 6–8. specific_user — remoteUserId required, well-formed, and the host
      //      portion must be a peered instance.
      if (body.remoteScope === 'specific_user') {
        if (!body.remoteUserId) {
          throw TavernError.validation('specific_user scope requires remoteUserId');
        }
        if (!REMOTE_USER_ID_RE.test(body.remoteUserId)) {
          throw TavernError.validation('remoteUserId is malformed (expected localpart@host)');
        }
        const host = body.remoteUserId.split('@')[1] ?? '';
        const peer = await prisma.remoteInstance.findUnique({
          where: { host },
          select: { status: true },
        });
        if (!peer || peer.status !== 'peered') {
          throw TavernError.validation("remoteUserId's host is not a peered instance");
        }
        // Pin BOTH the host and the user so a later identity rename on the
        // peer can't quietly widen the invite's audience.
        remoteInstanceHost = host;
        remoteUserId = body.remoteUserId;
      }
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
        remoteScope: body.remoteScope ?? null,
        remoteInstanceHost,
        remoteUserId,
      },
    });

    await writeAuditEntry({
      serverId: body.serverId ?? null,
      actorId: ctx.userId,
      action: 'invite.created',
      targetType: 'invite',
      targetId: invite.id,
      metadata: {
        scope: invite.scope,
        remoteScope: invite.remoteScope,
        remoteInstanceHost: invite.remoteInstanceHost,
        remoteUserId: invite.remoteUserId,
      },
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

  // List server-scoped invites. Anyone with CREATE_INVITES on the server
  // can see the active invite codes their teammates have minted (matches
  // Discord behaviour); the DELETE-level MANAGE_SERVER gate still applies
  // to revocation. Revoked / expired / exhausted invites are included so
  // the UI can surface history — the client decides what to filter.
  app.get('/api/servers/:id/invites', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.CREATE_INVITES);
    const rows = await prisma.invite.findMany({
      where: { serverId, scope: 'server' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        createdBy: {
          select: { id: true, username: true, displayName: true },
        },
      },
    });
    reply.send(
      ok(
        rows.map((i) => ({
          ...serializeInvite(i),
          createdBy: i.createdBy
            ? {
                id: i.createdBy.id,
                username: i.createdBy.username,
                displayName: i.createdBy.displayName,
              }
            : null,
        })),
      ),
    );
  });

  app.delete('/api/invites/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const invite = await prisma.invite.findUnique({ where: { id } });
    if (!invite) throw TavernError.notFound();
    if (invite.createdById === ctx.userId) {
      // Invite creators can revoke their own links. MANAGE_SERVER / instance
      // admin remains the override for links created by someone else.
    } else if (invite.serverId) {
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
    const { code: rawCode } = z.object({ code: z.string().min(4).max(64) }).parse(req.params);
    const code = rawCode.trim().toUpperCase();
    const invite = await prisma.invite.findUnique({ where: { code } });
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt < new Date())) {
      throw new TavernError('INVALID_INVITE', 'Invite is invalid or expired', 400);
    }
    // Instance-scoped invites are registration tickets — they don't redeem to
    // a server. An authenticated user landing here already belongs to the
    // instance, so we ack the call as a no-op with `serverId: null` instead of
    // 400ing. The client uses null to mean "you're already in, go home." No
    // `uses` increment, no audit, no MEMBER_ADD: nothing was consumed.
    if (invite.scope === 'instance') {
      reply.send(ok({ serverId: null }));
      return;
    }
    if (invite.scope !== 'server' || !invite.serverId) {
      throw TavernError.validation('Invite is not server-scoped');
    }

    const existing = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: invite.serverId, userId: ctx.userId } },
    });
    if (existing) {
      reply.send(ok({ serverId: invite.serverId }));
      return;
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw new TavernError('INVALID_INVITE', 'Invite has been fully used', 400);
    }
    if (await isBanned(invite.serverId, ctx.userId)) {
      throw new TavernError('MEMBER_BANNED', 'You are banned from this server', 403);
    }
    // Parity gap #4 — raid lockdown enforcement. When a lockdown is active,
    // `pause_invites` rejects the join outright; `require_approval` and
    // `quarantine` let the member in but stamp a timeout so they can't post
    // until the lockdown lifts or a mod clears them (reuses the timeout gate).
    let joinTimeoutUntil: Date | null = null;
    {
      const raid = await prisma.raidProtectionConfig.findUnique({
        where: { serverId: invite.serverId },
        select: { lockdownActive: true, lockdownAction: true, lockdownEndsAt: true },
      });
      if (raid?.lockdownActive) {
        if (raid.lockdownAction === 'pause_invites') {
          throw new TavernError(
            'INVALID_INVITE',
            'This tavern is locked down — joins are paused',
            403,
          );
        }
        joinTimeoutUntil = raid.lockdownEndsAt ?? new Date(Date.now() + 60 * 60 * 1000);
      }
    }
    {
      // RACE: atomic check-and-increment for maxUses. The plain check above
      // is a UX-friendly fast-fail; under N concurrent redeems on
      // `maxUses=1` it can let all N pass. Inside the transaction we
      // re-check + increment with a predicate (`uses: { lt: maxUses }`) so
      // only the first writer wins. Mirrors the registration flow in
      // auth-service which already uses this pattern.
      const newMember = await prisma.$transaction(async (tx) => {
        // TOCTOU: the pre-transaction ban check above is a UX fast-fail. A
        // moderator could ban this user in the window between that check and
        // the membership write — and the ban table is the only gate (there's
        // no DB constraint stopping a banned user from being a member). Re-
        // check against the transactional view before creating the row.
        if (await isBanned(invite.serverId!, ctx.userId, tx)) {
          throw new TavernError('MEMBER_BANNED', 'You are banned from this server', 403);
        }
        const consumed = await tx.invite.updateMany({
          where: {
            id: invite.id,
            revokedAt: null,
            scope: 'server',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            ...(invite.maxUses !== null ? { uses: { lt: invite.maxUses } } : {}),
          },
          data: { uses: { increment: 1 } },
        });
        if (consumed.count === 0) {
          throw new TavernError('INVALID_INVITE', 'Invite has been fully used', 400);
        }
        return tx.serverMember.create({
          data: {
            serverId: invite.serverId!,
            userId: ctx.userId,
            ...(joinTimeoutUntil ? { timeoutUntil: joinTimeoutUntil } : {}),
          },
        });
      });
      gatewayBroker.publish({
        type: 'MEMBER_ADD',
        serverId: invite.serverId,
        data: { serverId: invite.serverId, userId: ctx.userId },
      });

      // Parity gap #3 — system join message. Best-effort: a system-room outage
      // (or no configured room) must never break the join, so this is wrapped
      // and detached. Fires after the member row + MEMBER_ADD are committed.
      {
        const serverRow = await prisma.server.findUnique({
          where: { id: invite.serverId },
          select: { systemChannelId: true },
        });
        if (serverRow?.systemChannelId) {
          const joiner = await prisma.user.findUnique({
            where: { id: ctx.userId },
            select: { displayName: true },
          });
          if (joiner) {
            void postSystemMessage(
              invite.serverId,
              serverRow.systemChannelId,
              `**${joiner.displayName}** joined the tavern`,
            ).catch(() => undefined);
          }
        }
      }

      // P4-10 — fan out `member.add` to peers with members in this server.
      // Gated on:
      //   1. Deps wired in (FEDERATION_ENABLED at the instance level)
      //   2. Server is federated AND not a mirror of someone else's server
      // The joiner here is always LOCAL (this is the local-invite endpoint,
      // not federated-invite acceptance — see federation-invites-accept.ts),
      // so there is no `excludePeerInstanceId` to pass.
      if (deps?.queues && deps.selfHost) {
        try {
          const serverRow = await prisma.server.findUnique({
            where: { id: invite.serverId },
            select: {
              federationEnabled: true,
              originInstanceId: true,
            },
          });
          if (serverRow && serverRow.federationEnabled && serverRow.originInstanceId === null) {
            const joiner = await prisma.user.findUnique({
              where: { id: ctx.userId },
              select: { username: true, displayName: true },
            });
            if (joiner) {
              await fanOutMemberAdd({
                queues: deps.queues,
                selfHost: deps.selfHost,
                serverId: invite.serverId,
                memberRemoteUserId: `${joiner.username}@${deps.selfHost}`,
                memberDisplayName: joiner.displayName,
                joinedAt: newMember.joinedAt,
                authorUserId: ctx.userId,
                log: app.log,
                federationEnabledOnInstance: deps.federationEnabledOnInstance,
              });
            }
          }
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          app.log.warn(
            { err: errObj, serverId: invite.serverId, userId: ctx.userId },
            'federation fan-out failed for member.add (local invite join)',
          );
        }
      }
    }
    reply.send(ok({ serverId: invite.serverId }));
  });
}
