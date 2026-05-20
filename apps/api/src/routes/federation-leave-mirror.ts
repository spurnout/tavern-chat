/**
 * Federation Phase 4 — `POST /api/federation/mirror-servers/:serverId/leave`.
 *
 * Authenticated route. The calling user (the leaver) is asking THIS instance
 * (B) to voluntarily leave a mirror Server originated by a peer (A). The full
 * flow mirrors P4-6's invite-accept shape in reverse:
 *
 *   1. `requireUser` resolves the leaver's local User row.
 *   2. Look up the Server by id; verify `originInstanceId != null` (it must
 *      be a mirror); else 404.
 *   3. Look up the ServerMember row for `(serverId, ctx.userId)`; else 404.
 *   4. Build a `member.leave` envelope:
 *        - payload: { serverId, leaverRemoteUserId: `<localpart>@<selfHost>`,
 *          leftAt }
 *        - signed by the leaver's user key (layer 1)
 *        - AND by B's instance key (layer 2)
 *   5. POST synchronously to `https://{originHost}/_federation/event`.
 *      The home (A) replies with a single-layer signed `member.removed`
 *      envelope; this confirms A has dropped the ServerMember row on their
 *      side. Until we have that confirmation we do NOT modify local state —
 *      a leave that fails mid-flight should leave the user able to retry.
 *   6. Once A acks: inside a transaction, delete the local ServerMember row
 *      and call `tearDownMirrorServerIfEmpty`. The tear-down only fires if
 *      this user was the LAST local member of the mirror; otherwise the
 *      mirror is preserved for the remaining local members.
 *   7. Post-commit: if torn down, broadcast `SERVER_REMOVE` to the user so
 *      their sidebar splices the gone-mirror out. Otherwise broadcast
 *      `MEMBER_REMOVE` so any other local viewers of the mirror update
 *      their roster without a refetch.
 *   8. Reply 200 with `{ ok: true, data: { serverId, mirrorTornDown } }`.
 *
 * Edge cases:
 *   - Server is not a mirror (originInstanceId is null) → 404. Leaving a
 *     local Tavern goes through `routes/server-members.ts`, not here.
 *   - Caller isn't a member → 404. Same shape as the "no such server" path
 *     so a peer can't probe membership by trying to leave.
 *   - Home returns 4xx → propagate the status. The user's local state is
 *     unchanged; the SPA can show the error and let them retry.
 *   - Home returns 5xx / network error → 502, local state unchanged.
 *
 * What deliberately does NOT happen here:
 *   - We do NOT optimistically delete the local ServerMember before A acks.
 *     If A rejects (e.g. the mirror was already torn down on their side
 *     and they 404'd us), an optimistic delete would orphan the user's
 *     view: they think they left, but A still has them. The synchronous
 *     model matches the P4-6 accept route — both atomically reconcile both
 *     sides of the membership relationship.
 *   - We do NOT cascade-delete the local synthetic owner / member User
 *     rows when the mirror tears down. The mirror service preserves those
 *     for idempotency on a future re-join; the same rationale applies
 *     here.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@tavern/db';
import {
  TavernError,
  memberLeavePayloadSchema,
  memberRemovedPayloadSchema,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  postFederationEventSync,
  type FederationKeyStore,
  type PostFederationEventSyncFn,
  type UserKeyStore,
} from '@tavern/federation';
import { ok, fail } from '../lib/responses.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { FederationMirrorService } from '../services/federation-mirror.js';

export interface FederationLeaveMirrorRouteDeps {
  /** Instance keystore — signs the layer-2 envelope. */
  keys: FederationKeyStore;
  /** Per-user keystore — leaver's signing key. */
  userKeys: UserKeyStore;
  /** This instance's federation host (e.g. `b.example`). */
  selfHost: string;
  /**
   * Override for tests so we don't fire real network requests. Defaults to
   * the real `postFederationEventSync`.
   */
  postSyncImpl?: PostFederationEventSyncFn;
}

const paramsSchema = z.object({ serverId: z.string().min(1).max(64) });

export function registerFederationLeaveMirrorRoutes(
  app: FastifyInstance,
  deps: FederationLeaveMirrorRouteDeps,
): void {
  app.post<{ Params: { serverId: string } }>(
    '/api/federation/mirror-servers/:serverId/leave',
    async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { serverId } = paramsSchema.parse(req.params);

      // 1) Load the leaver's username — we need `localpart@selfHost` for
      //    the qualified id in the envelope payload.
      const leaver = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, username: true },
      });
      if (!leaver) {
        // requireUser succeeded but the User row vanished — defensive guard.
        throw TavernError.notFound('Leaver user not found');
      }

      // 2) Verify the Server is a mirror. We use the SAME error code
      //    (NOT_FOUND) for both "server doesn't exist" and "server is local
      //    not a mirror" so that a peer can't enumerate mirrors by trying
      //    to leave random ids.
      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, originInstanceId: true },
      });
      if (!server || server.originInstanceId === null) {
        return reply
          .code(404)
          .send(fail('NOT_FOUND', `mirror server ${serverId} not found`));
      }

      // 3) Verify the caller is currently a member. Same code as above —
      //    "not a member" doesn't leak whether the mirror exists.
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: leaver.id } },
        select: { userId: true },
      });
      if (!member) {
        return reply
          .code(404)
          .send(fail('NOT_FOUND', `not a member of mirror server ${serverId}`));
      }

      // 4) Resolve the origin peer — `RemoteInstance` row pinned by the
      //    server's `originInstanceId`. Must be peered; revoked / blocked
      //    home means the operator has cut ties and we can't safely
      //    deliver a leave envelope. In that case we fall through to a
      //    503 — the local state mismatch is real but the leaver can't
      //    fix it via this endpoint. (Operators with an unreachable home
      //    can manually clean up; that's out of scope for this route.)
      const origin = await prisma.remoteInstance.findUnique({
        where: { id: server.originInstanceId },
        select: { id: true, host: true, status: true, instanceKey: true },
      });
      if (!origin || origin.status !== 'peered') {
        return reply
          .code(503)
          .send(
            fail(
              'INTERNAL_ERROR',
              `cannot leave: origin peer ${origin?.host ?? server.originInstanceId} is not currently peered`,
            ),
          );
      }

      const leaverRemoteUserId = `${leaver.username}@${deps.selfHost}`;

      // 5) Build the two-layer envelope.
      //    Layer 1 — leaver's user key signs the canonical payload.
      //    Layer 2 — B's instance key signs the canonical envelope.
      await deps.userKeys.ensureKeyFor(leaver.id);
      const userKey = await deps.userKeys.loadKeyFor(leaver.id);

      const payload = {
        serverId,
        leaverRemoteUserId,
        leftAt: new Date().toISOString(),
      };
      // Defence-in-depth: validate our own outgoing payload against the
      // wire schema before signing. Catches drift between this code and
      // the schema at the sending side rather than at the home peer.
      memberLeavePayloadSchema.parse(payload);

      const envelope = buildTwoLayerMessageEnvelope({
        eventType: 'member.leave',
        fromInstance: deps.selfHost,
        toInstance: origin.host,
        payload,
        signUser: userKey.sign,
        signInstance: (bytes) => deps.keys.sign(bytes),
      });

      // 6) Synchronously POST to A. The home replies with a single-layer
      //    signed `member.removed` envelope confirming the delete on their
      //    side; on 4xx/5xx / network error we surface the failure and
      //    DO NOT touch local state.
      const dispatch = deps.postSyncImpl ?? postFederationEventSync;
      const result = await dispatch({
        peerHost: origin.host,
        envelope,
        expectedPayloadSchema: memberRemovedPayloadSchema,
        peerPublicKeyRaw: Buffer.from(origin.instanceKey),
        selfHost: deps.selfHost,
      });

      if (!result.ok) {
        const status = result.status;
        if (status >= 400 && status < 500) {
          // 401 unauthorized_leave (envelope signed by someone other than
          // the leaver — shouldn't happen since we built the envelope, but
          // surface it) maps to UNAUTHORIZED. 404 unknown_member /
          // unknown_mirror maps to NOT_FOUND (the home no longer knows
          // about the membership; treat as "already left" — see below).
          // Everything else → PERMISSION_DENIED.
          let errorCode: 'UNAUTHORIZED' | 'NOT_FOUND' | 'PERMISSION_DENIED';
          if (status === 401) {
            errorCode = 'UNAUTHORIZED';
          } else if (status === 404) {
            errorCode = 'NOT_FOUND';
          } else {
            errorCode = 'PERMISSION_DENIED';
          }
          return reply.code(status).send(fail(errorCode, result.reason));
        }
        return reply
          .code(502)
          .send(fail('INTERNAL_ERROR', `home unreachable: ${result.reason}`));
      }

      // Defence-in-depth shape check. The dispatch helper already parsed
      // the payload via memberRemovedPayloadSchema, but a peer that acked
      // a DIFFERENT serverId is either buggy or hostile.
      if (
        result.payload.serverId !== serverId ||
        result.payload.leaverRemoteUserId !== leaverRemoteUserId
      ) {
        return reply.code(502).send(
          fail(
            'INTERNAL_ERROR',
            `home acked a different (serverId, leaverRemoteUserId) than we sent`,
          ),
        );
      }

      // 7) Commit the local delete + optional tear-down. Both are done in
      //    one transaction so a partial failure rolls back cleanly. The
      //    mirror service's resolveRemoteUser callback is NOT used here —
      //    we don't add or look up remote users — so we pass a throwing
      //    stub to surface any accidental call.
      const mirrorService = new FederationMirrorService({
        resolveRemoteUser: () => {
          throw new Error(
            'leave-mirror route should not resolve remote users',
          );
        },
      });

      const txOutput = await prisma.$transaction(async (tx) => {
        // Re-check the member row inside the transaction. Between the
        // pre-flight check and the POST to A, a concurrent request from
        // the same user could have completed a parallel leave. Treat the
        // missing row as a no-op (idempotent success).
        const stillMember = await tx.serverMember.findUnique({
          where: { serverId_userId: { serverId, userId: leaver.id } },
          select: { userId: true },
        });
        if (stillMember) {
          await tx.serverMember.delete({
            where: { serverId_userId: { serverId, userId: leaver.id } },
          });
        }
        const tornDown = await mirrorService.tearDownMirrorServerIfEmpty(
          tx,
          serverId,
        );
        return { mirrorTornDown: tornDown };
      });

      // 8) Post-commit broadcast.
      //   - tornDown=true: the Server row is gone; broadcast SERVER_REMOVE
      //     to the leaver so their sidebar splices it out. We don't fire
      //     MEMBER_REMOVE because there's no remaining audience for it
      //     (the mirror's gone).
      //   - tornDown=false: the mirror survives. Broadcast MEMBER_REMOVE
      //     scoped to the (now-vanished) serverId so other local viewers
      //     update their rosters. The recipient set is computed by the
      //     gateway via shouldDeliver — anyone who was a member of the
      //     mirror still hears.
      if (txOutput.mirrorTornDown) {
        gatewayBroker.publish({
          type: 'SERVER_REMOVE',
          userId: leaver.id,
          data: { serverId },
        });
      } else {
        // serverId-targeted MEMBER_REMOVE. The leaver also receives this
        // (they're still in the audience until their client processes
        // it); the SPA treats receiving a MEMBER_REMOVE for itself as a
        // hint to drop the row from the in-memory roster.
        gatewayBroker.publish({
          type: 'MEMBER_REMOVE',
          serverId,
          data: { serverId, userId: leaver.id },
        });
      }
      reply
        .code(200)
        .send(
          ok({ serverId, mirrorTornDown: txOutput.mirrorTornDown }),
        );
    },
  );
}
