/**
 * Federation Phase 3 — admin-only manual remote-member addition.
 *
 * `POST /api/admin/servers/:id/remote-members`
 *
 * This is the "Phase 3 testing backdoor" that lets an instance admin paste a
 * qualified `alice@b.example` identifier and have the remote user materialised
 * locally (RemoteUser cache row + synthetic User row) and added as a
 * ServerMember to the target server. It exists so the full Phase 3 stack
 * (fan-out, signature verification, inbox plumbing) can be exercised end-to-end
 * without waiting for the Phase 4 federated-invite flow.
 *
 * Security:
 *   - Instance-admin only (defence-in-depth with the `FEDERATION_ENABLED`
 *     gate at the registration site in app.ts).
 *   - Calls into `FederationProfileService.fetchRemoteProfile`, which already
 *     enforces the SSRF allow-list via `assertValidPeerHost` and refuses
 *     non-peered hosts. We do not call the network directly from here.
 *
 * Idempotency:
 *   - Adding the same remoteUserId twice returns 200 with the existing
 *     ServerMember row instead of failing with a P2002 violation. The path is
 *     a testing tool — admins re-running the same command on a fresh terminal
 *     shouldn't be punished.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@tavern/db';
import { TavernError, idSchema } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import type { FederationProfileService } from '../services/federation-profile.js';
import { PeeringError } from '../services/federation-peering.js';
import { ensureUserForRemoteUser } from '../services/remote-user-upsert.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { fanOutMemberAdd } from '../services/federation-outbox.js';
import type { QueueClient } from '../services/queues.js';

export interface AdminServerRemoteMembersDeps {
  profile: FederationProfileService;
  /**
   * Queue client for the P4-10 `member.add` fan-out when an admin adds a
   * remote member to a federated server. Optional — when omitted (or when
   * `selfHost` is missing) the hook short-circuits.
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

const paramsSchema = z.object({ id: idSchema });
const bodySchema = z.object({
  // Qualified id "alice@b.example". Min 3 catches the degenerate `a@b` shape,
  // max 253 matches the DNS hostname cap (and is consistent with the lookup
  // route in users-federated.ts).
  remoteUserId: z.string().min(3).max(253),
});

export function registerAdminServerRemoteMembersRoutes(
  app: FastifyInstance,
  deps: AdminServerRemoteMembersDeps,
): void {
  app.post('/api/admin/servers/:id/remote-members', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!ctx.isInstanceAdmin) throw TavernError.forbidden('Instance admins only');

    const { id: serverId } = paramsSchema.parse(req.params);
    const { remoteUserId } = bodySchema.parse(req.body);

    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: {
        id: true,
        federationEnabled: true,
        originInstanceId: true,
      },
    });
    if (!server) {
      throw TavernError.notFound('Server not found');
    }

    // Resolve / refresh the remote profile. fetchRemoteProfile is the single
    // entry point that already handles cache hit, cache miss, SSRF guard and
    // peer-not-peered enforcement. The error surface is documented in the
    // service file and mirrors the mapping used by users-federated.ts.
    try {
      await deps.profile.fetchRemoteProfile(remoteUserId);
    } catch (err) {
      if (err instanceof PeeringError) {
        // assertValidPeerHost SSRF rejections come through as PeeringError
        // with code `bad_envelope`. Map to 400.
        throw TavernError.validation(err.message);
      }
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg.startsWith('invalid remoteUserId')) {
        throw TavernError.validation(msg);
      }
      if (msg.includes('is not a peered remote instance')) {
        throw TavernError.notFound(`unknown peer: ${msg}`);
      }
      // Network / signature / schema failures fetching from the peer.
      reply.code(502).send({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: `remote profile unreachable: ${msg}`,
        },
      });
      return;
    }

    // fetchRemoteProfile guarantees the RemoteUser row exists at this point.
    const remoteUser = await prisma.remoteUser.findUnique({
      where: { remoteUserId },
    });
    if (!remoteUser) {
      // Should be unreachable — fetchRemoteProfile upserts the row before
      // returning. Treat as 500.
      throw TavernError.internal('RemoteUser row missing after profile fetch');
    }

    const localUser = await ensureUserForRemoteUser(remoteUser, prisma);

    try {
      const newMember = await prisma.serverMember.create({
        data: { serverId, userId: localUser.id },
      });
      gatewayBroker.publish({
        type: 'MEMBER_ADD',
        serverId,
        data: { serverId, userId: localUser.id },
      });

      // P4-10 — fan out `member.add` to OTHER peers with members in this
      // server. The newly-added user is themselves remote; their home peer
      // (remoteUser.remoteInstanceId) is excluded because that peer doesn't
      // know about T at all (P3-12 is the admin testing backdoor — there
      // is no mirror on the user's home side). Every other peer of T,
      // however, needs to see the new member so its mirror stays in sync.
      if (
        deps.queues &&
        deps.selfHost &&
        server.federationEnabled &&
        server.originInstanceId === null
      ) {
        try {
          await fanOutMemberAdd({
            queues: deps.queues,
            selfHost: deps.selfHost,
            serverId,
            memberRemoteUserId: remoteUser.remoteUserId,
            memberDisplayName: remoteUser.displayNameCache,
            joinedAt: newMember.joinedAt,
            // The signing user is the admin acting locally — they are the
            // only local actor in this flow, and the remote user's own
            // key is not loadable here (we never hold the private half).
            authorUserId: ctx.userId,
            log: app.log,
            excludePeerInstanceId: remoteUser.remoteInstanceId,
            federationEnabledOnInstance: deps.federationEnabledOnInstance,
          });
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          app.log.warn(
            { err: errObj, serverId, userId: localUser.id, remoteUserId },
            'federation fan-out failed for member.add (admin remote-member add)',
          );
        }
      }

      reply.code(201).send(
        ok({
          member: {
            serverId,
            userId: localUser.id,
            remoteUserId,
          },
        }),
      );
    } catch (err) {
      // Already a member — idempotent success on the composite-PK unique
      // violation. Anything else is a real error and propagates.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        reply.code(200).send(
          ok({
            member: {
              serverId,
              userId: localUser.id,
              remoteUserId,
            },
            alreadyMember: true,
          }),
        );
        return;
      }
      throw err;
    }
  });
}
