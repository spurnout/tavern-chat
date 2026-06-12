import type { FastifyInstance } from 'fastify';
import { Prisma, prisma, resolveServerIconUrl } from '@tavern/db';
import { z } from 'zod';
import {
  createServerRequestSchema,
  idSchema,
  Permission,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_NONE,
  serializePermissions,
  TavernError,
  ulid,
  updateMemberNicknameRequestSchema,
  updateServerRequestSchema,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  serializeChannel,
  serializeMember,
  serializeRole,
  serializeServer,
  serializeVoiceStateGatewayPayload,
} from '../lib/serializers.js';
import {
  filterVisibleChannels,
  getServerPermissions,
  requireServerPermission,
} from '../services/permissions-service.js';
import { writeAuditEntry } from '../services/audit-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { fanOutServerUpdate } from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';
import type { StorageBackend } from '@tavern/media';

const VOICE_ROOM_TYPES = new Set(['voice', 'session', 'campaign', 'stage']);

interface ServerRouteDeps {
  /**
   * Whether this instance has federation enabled at the config level. P3-10
   * gates the per-Tavern `federationEnabled` toggle on this: an admin can't
   * set it to true unless the operator has also enabled federation on the
   * instance. Without this, the flag would be stored but have no effect
   * (the fan-out helper checks both layers).
   */
  federationEnabledOnInstance: boolean;
  /**
   * Queue client used to enqueue outbound federation envelopes for the P4-9
   * server.update fan-out. Optional — when omitted (or when `selfHost` is
   * missing), the fan-out hook short-circuits and the local SERVER_UPDATE
   * broadcast is unaffected.
   */
  queues?: QueueClient;
  /** The local instance's federation host (e.g. `a.example`). */
  selfHost?: string | null;
  /**
   * Storage backend — resolves a local icon attachment id into the public
   * `Server.iconUrl` when an icon is set via PATCH. Optional: when omitted
   * (some unit harnesses) icon-URL resolution degrades to null rather than
   * crashing; the production app always injects it.
   */
  storage?: StorageBackend;
}

export async function registerServerRoutes(
  app: FastifyInstance,
  deps: ServerRouteDeps = { federationEnabledOnInstance: false },
): Promise<void> {
  // List my servers --------------------------------------------------------
  app.get('/api/servers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const memberships = await prisma.serverMember.findMany({
      where: { userId: ctx.userId },
      // P4-16 — pull `originInstance.host` so the sidebar can render the
      // "🌐 host" badge on mirror rows without a follow-up fetch per server.
      // The relation is nullable in Prisma (`SetNull` on origin delete), so
      // for local servers and orphaned mirrors `originInstance` is null and
      // the serializer maps that to a null `originInstanceHost` on the wire.
      include: {
        server: { include: { originInstance: { select: { host: true } } } },
      },
      orderBy: { joinedAt: 'asc' },
    });
    reply.send(ok(memberships.map((m) => serializeServer(m.server))));
  });

  // Create a server --------------------------------------------------------
  app.post('/api/servers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createServerRequestSchema.parse(req.body);

    const serverId = ulid();
    const everyoneRoleId = ulid();

    const server = await prisma.$transaction(async (tx) => {
      await tx.server.create({
        data: {
          id: serverId,
          ownerUserId: ctx.userId,
          name: body.name,
          description: body.description ?? null,
        },
      });
      await tx.role.create({
        data: {
          id: everyoneRoleId,
          serverId,
          name: '@everyone',
          color: 0,
          position: 0,
          isEveryone: true,
          permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
        },
      });
      const updated = await tx.server.update({
        where: { id: serverId },
        data: { defaultRoleId: everyoneRoleId },
      });
      await tx.serverMember.create({
        data: { serverId, userId: ctx.userId },
      });
      await tx.channel.create({
        data: {
          id: ulid(),
          serverId,
          type: 'text',
          name: 'general',
          topic: 'Welcome.',
          position: 0,
        },
      });
      await tx.safetyPolicy.create({
        data: { serverId },
      });
      return updated;
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: 'server.created',
      targetType: 'server',
      targetId: serverId,
    });

    reply.status(201).send(ok(serializeServer(server)));
  });

  // Get a single server (must be a member) ---------------------------------
  app.get('/api/servers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    // P4-16 — pull originInstance.host so the den-settings Federation tab can
    // render the leave-this-den UI for mirror servers without a separate
    // round-trip to resolve the host.
    const server = await prisma.server.findUnique({
      where: { id },
      include: { originInstance: { select: { host: true } } },
    });
    if (!server) throw TavernError.notFound('Server not found');
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: id, userId: ctx.userId } },
    });
    if (!member && server.ownerUserId !== ctx.userId) {
      throw TavernError.notFound('Server not found');
    }
    reply.send(ok(serializeServer(server)));
  });

  // Update a server --------------------------------------------------------
  app.patch('/api/servers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateServerRequestSchema.parse(req.body);
    await requireServerPermission(id, ctx.userId, Permission.MANAGE_SERVER);

    // P3-10 — instance-level gate. Setting `federationEnabled=true` on a
    // tavern hosted by a non-federated instance is rejected up front (rather
    // than silently stored) so the UI / API surface never accumulates flags
    // that would do nothing today and would suddenly take effect if the
    // operator later flipped FEDERATION_ENABLED on. Turning it back off is
    // always allowed, regardless of the instance setting, so an operator
    // downgrading from federated → not-federated can still let admins clean
    // up their tavern flags.
    if (body.federationEnabled === true && !deps.federationEnabledOnInstance) {
      throw TavernError.validation(
        'Federation is not enabled on this instance. Ask the operator to set FEDERATION_ENABLED=true in the .env.',
      );
    }

    // Pre-PATCH read — we need `originInstanceId` (to skip the fan-out when
    // T is a MIRROR of somebody else's server) and `ownerUserId` (the
    // user-layer signer for the outbound envelope). One round-trip up front
    // beats threading these through the update's `select`.
    const beforeRow = await prisma.server.findUnique({
      where: { id },
      select: { id: true, originInstanceId: true, ownerUserId: true, federationEnabled: true },
    });
    if (!beforeRow) throw TavernError.notFound('Server not found');

    // Parity gap #3 — validate the system room belongs to this tavern before
    // storing it. Null clears it (no validation needed).
    if (body.systemChannelId) {
      const channel = await prisma.channel.findUnique({
        where: { id: body.systemChannelId },
        select: { serverId: true },
      });
      if (!channel || channel.serverId !== id) {
        throw TavernError.validation('That room is not part of this tavern');
      }
    }

    // When the icon attachment changes, resolve its public URL up front so the
    // column stays in lock-step with `iconAttachmentId`. Clearing the icon
    // (null) clears the URL; setting it resolves via storage (null until the
    // attachment is `ready` — `refreshServerIconsForAttachment` backfills it
    // on scan-complete). When `storage` isn't wired (unit harness) we degrade
    // to null rather than crashing.
    const iconUrlPatch: { iconUrl?: string | null } =
      body.iconAttachmentId !== undefined
        ? {
            iconUrl: deps.storage
              ? await resolveServerIconUrl(body.iconAttachmentId, deps.storage)
              : null,
          }
        : {};

    const updated = await prisma.server.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.iconAttachmentId !== undefined ? { iconAttachmentId: body.iconAttachmentId } : {}),
        ...iconUrlPatch,
        ...(body.federationEnabled !== undefined
          ? { federationEnabled: body.federationEnabled }
          : {}),
        ...(body.systemChannelId !== undefined
          ? { systemChannelId: body.systemChannelId }
          : {}),
        ...(body.verificationLevel !== undefined
          ? { verificationLevel: body.verificationLevel }
          : {}),
        ...(body.verificationMinAccountAgeHours !== undefined
          ? { verificationMinAccountAgeHours: body.verificationMinAccountAgeHours }
          : {}),
      },
      // P4-16 — broadcast the SERVER_UPDATE with `originInstanceHost`
      // populated so mirror rows in the sidebar keep their badge on rename.
      include: { originInstance: { select: { host: true } } },
    });

    await writeAuditEntry({
      serverId: id,
      actorId: ctx.userId,
      action: 'server.updated',
      targetType: 'server',
      targetId: id,
      metadata: body as Record<string, unknown>,
    });
    gatewayBroker.publish({
      type: 'SERVER_UPDATE',
      serverId: id,
      data: serializeServer(updated),
    });

    // P4-9 — fan out the server update to every peered instance that has a
    // member in this server. Best-effort: local clients have already received
    // the broadcast above. Gated on:
    //   1. Deps (queues + selfHost) wired in — i.e. FEDERATION_ENABLED is on
    //   2. T is NOT a mirror of somebody else's server (originInstanceId is
    //      null). A doesn't push updates for B's mirror back to B.
    //   3. T's federationEnabled flag is true POST-update.
    //
    // If the PATCH is itself the "turn federation off" hop, the post-update
    // flag is false and no envelope fires. Peers keep their existing mirror
    // until the next time the operator flips federation back on (Phase 4
    // intentionally does not synthesise a "federation went away" envelope at
    // the server level — that surface area is reserved for a later phase).
    if (
      deps.queues &&
      deps.selfHost &&
      beforeRow.originInstanceId === null &&
      updated.federationEnabled
    ) {
      try {
        const owner = await prisma.user.findUnique({
          where: { id: updated.ownerUserId },
          select: { username: true },
        });
        if (owner) {
          // Send the resolved public icon URL to peers only when the PATCH
          // actually touched the icon; leave it `undefined` (preserve the
          // peer's current icon) otherwise. `updated.iconUrl` is the canonical
          // capability URL — absolute and peer-fetchable — or null when the
          // icon was cleared or its attachment isn't `ready` yet.
          const iconUrl =
            body.iconAttachmentId !== undefined ? updated.iconUrl : undefined;
          await fanOutServerUpdate({
            queues: deps.queues,
            selfHost: deps.selfHost,
            serverId: id,
            ownerUserId: updated.ownerUserId,
            ownerUsername: owner.username,
            name: body.name,
            description: body.description,
            iconUrl,
            log: app.log,
            federationEnabledOnInstance: deps.federationEnabledOnInstance,
          });
        }
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        app.log.warn(
          { err: errObj, serverId: id },
          'federation fan-out failed for server.update',
        );
      }
    }

    reply.send(ok(serializeServer(updated)));
  });

  // Delete a server (owner only) -------------------------------------------
  app.delete('/api/servers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) throw TavernError.notFound('Server not found');
    if (server.ownerUserId !== ctx.userId) throw TavernError.forbidden('Only the owner can delete a server');

    await prisma.server.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  // Members ----------------------------------------------------------------
  app.get('/api/servers/:id/members', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Server not found');
    const members = await prisma.serverMember.findMany({
      where: { serverId: id },
      include: {
        roles: true,
        user: { select: { id: true, displayName: true, username: true, presence: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
    reply.send(
      ok(
        members.map((m) =>
          serializeMember({
            serverId: m.serverId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            timeoutUntil: m.timeoutUntil,
            roles: m.roles,
            user: m.user,
          }),
        ),
      ),
    );
  });

  // Server-level permissions for the calling user. Returned as a decimal
  // BigInt string so the client can `& flag` against the existing Permission
  // bitset. Used by UI gates that need to know "can I do X on this server"
  // without round-tripping for every action.
  app.get('/api/servers/:id/permissions/me', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === PERMISSION_NONE) throw TavernError.notFound('Server not found');
    reply.send(ok({ serverId: id, permissions: serializePermissions(perms) }));
  });

  // Roles ------------------------------------------------------------------
  app.get('/api/servers/:id/roles', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Server not found');
    const roles = await prisma.role.findMany({
      where: { serverId: id },
      orderBy: { position: 'asc' },
    });
    reply.send(ok(roles.map((r) => serializeRole(r))));
  });

  // Edit a member's nickname (your own, or someone else's with MANAGE_NICKNAMES).
  app.patch('/api/servers/:serverId/members/:userId', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { serverId, userId } = z
      .object({ serverId: idSchema, userId: idSchema })
      .parse(req.params);
    const body = updateMemberNicknameRequestSchema.parse(req.body);

    // Editing someone else's nickname needs MANAGE_NICKNAMES; editing your
    // own is a basic civic right (any current member can rename themselves
    // on a server they belong to).
    if (ctx.userId !== userId) {
      await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_NICKNAMES);
    } else {
      const perms = await getServerPermissions(serverId, ctx.userId);
      if (perms === 0n) throw TavernError.notFound('Server not found');
    }

    const existing = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
      select: { userId: true },
    });
    if (!existing) throw TavernError.notFound('Member not found');

    await prisma.serverMember.update({
      where: { serverId_userId: { serverId, userId } },
      data: { nickname: body.nickname },
    });

    await writeAuditEntry({
      serverId,
      actorId: ctx.userId,
      action: ctx.userId === userId ? 'member.nickname.self' : 'member.nickname.set',
      targetType: 'user',
      targetId: userId,
      metadata: { nickname: body.nickname },
    });

    gatewayBroker.publish({
      type: 'MEMBER_UPDATE',
      serverId,
      data: { serverId, userId, nickname: body.nickname },
    });

    reply.send(ok({ serverId, userId, nickname: body.nickname }));
  });

  // Channels ---------------------------------------------------------------
  app.get('/api/servers/:id/channels', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const perms = await getServerPermissions(id, ctx.userId);
    if (perms === 0n) throw TavernError.notFound('Server not found');
    const all = await prisma.channel.findMany({
      where: { serverId: id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    const visible = await filterVisibleChannels(all, ctx.userId);
    const visibleVoiceIds = visible
      .filter((c) => VOICE_ROOM_TYPES.has(c.type))
      .map((c) => c.id);
    const voiceStates =
      visibleVoiceIds.length === 0
        ? []
        : await prisma.voiceState.findMany({
            where: {
              channelId: { in: visibleVoiceIds },
              joinedAt: { not: null },
            },
            orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
          });
    const voiceStatesByChannel = new Map<string, typeof voiceStates>();
    for (const state of voiceStates) {
      if (!state.channelId) continue;
      const list = voiceStatesByChannel.get(state.channelId) ?? [];
      list.push(state);
      voiceStatesByChannel.set(state.channelId, list);
    }

    reply.send(
      ok(
        visible.map((c) => {
          const channel = serializeChannel(c);
          if (!VOICE_ROOM_TYPES.has(c.type)) return channel;
          return {
            ...channel,
            voiceStates: (voiceStatesByChannel.get(c.id) ?? []).map(
              serializeVoiceStateGatewayPayload,
            ),
          };
        }),
      ),
    );
  });
}
