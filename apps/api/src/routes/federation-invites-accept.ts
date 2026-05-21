/**
 * Federation Phase 4 — `POST /api/federation/invites/:code/accept`.
 *
 * Authenticated route. The calling user (the joiner) is asking THIS instance
 * (B) to redeem a federated invite minted on a peer (A). The full flow:
 *
 *   1. `requireUser` resolves the joiner's local User row.
 *   2. Body must include `remoteInstanceHost` — A's hostname. We look up the
 *      corresponding `RemoteInstance` row; if not peered, 403.
 *   3. Build a `member.join_request` envelope:
 *        - payload: { inviteCode, joinerRemoteUserId: 'localpart@selfHost' }
 *        - signed by the joiner's user key (layer 1)
 *        - AND by B's instance key (layer 2)
 *   4. POST it synchronously to `https://{remoteInstanceHost}/_federation/event`.
 *      We need the SNAPSHOT back to mirror locally, so this is NOT outbox-
 *      based — request/response pattern.
 *   5. Verify the response is `member.joined` (single-layer envelope, signed
 *      by A's instance key) carrying the server snapshot.
 *   6. In a single transaction:
 *        a. createMirrorServer (if not yet mirrored — idempotent on the
 *           second accept). The synthetic owner + @everyone role are set up
 *           here.
 *        b. For each channel in the snapshot — upsertMirrorChannel.
 *        c. addMirrorMember for every member in the snapshot (the joiner
 *           themselves and every existing remote member). Each becomes a
 *           synthetic local User + ServerMember.
 *   7. Post-commit: gateway broadcast `SERVER_ADD` to the joiner so their
 *      sidebar live-updates without a full READY refresh.
 *   8. Reply 200 with `{ ok: true, data: { serverId, mirrored: true } }`.
 *
 * Edge cases (per the task spec):
 *   - Mirror already exists AND the user is already a member → idempotent
 *     200, no further work.
 *   - Mirror exists but the joiner isn't a member yet → just `addMirrorMember`
 *     for the joiner; do NOT re-snapshot (the existing mirror state is the
 *     source of truth for everyone else).
 *   - Home rejects with a 4xx → surface the same status code to the caller.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@tavern/db';
import {
  TavernError,
  memberJoinRequestPayloadSchema,
  memberJoinedPayloadSchema,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  postFederationEventSync,
  type FederationKeyStore,
  type PostFederationEventSyncFn,
  type UserKeyStore,
} from '@tavern/federation';
import { ok, fail } from '../lib/responses.js';
import { serializeServer } from '../lib/serializers.js';
import { gatewayBroker } from '../services/gateway-broker.js';
import { FederationMirrorService } from '../services/federation-mirror.js';
import type { FederationProfileService } from '../services/federation-profile.js';
import { makeProfileBackedRemoteUserResolver } from '../services/mirror-remote-user-resolver.js';

export interface FederationInvitesAcceptRouteDeps {
  /** Instance keystore — needed to sign the outgoing two-layer envelope. */
  keys: FederationKeyStore;
  /** Per-user keystore — joiner's signing key. */
  userKeys: UserKeyStore;
  /** Profile fetcher — used by the mirror resolver to materialise remote members. */
  profile: FederationProfileService;
  /** This instance's federation host (e.g. `b.example`). */
  selfHost: string;
  /**
   * Override for tests so we don't fire real network requests. Defaults to
   * the real `postFederationEventSync`.
   */
  postSyncImpl?: PostFederationEventSyncFn;
}

const paramsSchema = z.object({ code: z.string().min(1).max(64) });
const bodySchema = z.object({
  remoteInstanceHost: z.string().min(1).max(253),
});

export function registerFederationInvitesAcceptRoutes(
  app: FastifyInstance,
  deps: FederationInvitesAcceptRouteDeps,
): void {
  app.post<{ Params: { code: string } }>(
    '/api/federation/invites/:code/accept',
    async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { code } = paramsSchema.parse(req.params);
      const { remoteInstanceHost } = bodySchema.parse(req.body);

      // 1) Load the joiner's username — we need `localpart@selfHost` for the
      //    qualified id we send to A. The actual signing key bytes are
      //    loaded via `userKeys.loadKeyFor` below, which will materialise
      //    the keypair if it's missing.
      const joiner = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, username: true },
      });
      if (!joiner) {
        // Shouldn't happen — requireUser succeeded — but guard for completeness.
        throw TavernError.notFound('Joiner user not found');
      }

      // 2) Look up the home peer. Must be in `status='peered'` — anything else
      //    rejects with 403. We DON'T preview here; the preview was the
      //    Phase-4 client UX before this endpoint, and the home enforces its
      //    own scope check on the inbound member.join_request.
      const peer = await prisma.remoteInstance.findUnique({
        where: { host: remoteInstanceHost },
        select: { id: true, host: true, status: true, instanceKey: true },
      });
      if (!peer || peer.status !== 'peered') {
        return reply
          .code(403)
          .send(
            fail('PERMISSION_DENIED', `host ${remoteInstanceHost} is not a peered instance`),
          );
      }

      const joinerRemoteUserId = `${joiner.username}@${deps.selfHost}`;

      // 3) Build the two-layer envelope.
      //    Layer 1 — joiner's user key signs the canonical payload.
      //    Layer 2 — B's instance key signs the canonical envelope (which
      //              includes the user signature so a malicious A can't
      //              strip it).
      await deps.userKeys.ensureKeyFor(joiner.id);
      const userKey = await deps.userKeys.loadKeyFor(joiner.id);

      const payload = {
        inviteCode: code,
        joinerRemoteUserId,
      };
      // Defence-in-depth — make sure our outgoing payload matches the wire
      // schema. The home will re-validate; failing fast here catches local
      // bugs before they generate noisy 4xx replies on the peer.
      memberJoinRequestPayloadSchema.parse(payload);

      const envelope = buildTwoLayerMessageEnvelope({
        eventType: 'member.join_request',
        fromInstance: deps.selfHost,
        toInstance: peer.host,
        payload,
        signUser: userKey.sign,
        signInstance: (bytes) => deps.keys.sign(bytes),
      });

      // 4) Synchronously POST to A. Phase-4 reuses the existing
      //    `_federation/event` ingress on the home, but the response is
      //    SINGLE-LAYER (instance-to-instance ack signed only by A's
      //    instance key; see packages/shared/src/federation/membership.ts).
      const dispatch = deps.postSyncImpl ?? postFederationEventSync;
      const result = await dispatch({
        peerHost: peer.host,
        envelope,
        expectedPayloadSchema: memberJoinedPayloadSchema,
        peerPublicKeyRaw: Buffer.from(peer.instanceKey),
        selfHost: deps.selfHost,
      });

      if (!result.ok) {
        // 5) Home rejected — propagate the 4xx code so the SPA can show the
        //    same error to the user. 5xx + network errors map to 502 (we
        //    can't distinguish "home crashed" from "peer in middle dropped
        //    packet" reliably).
        const status = result.status;
        if (status >= 400 && status < 500) {
          // 410 invite_no_longer_valid → INVALID_INVITE for consistency with
          // the preview route. 404 → NOT_FOUND. Everything else → PERMISSION_DENIED.
          let errorCode: 'INVALID_INVITE' | 'NOT_FOUND' | 'PERMISSION_DENIED';
          if (status === 410) {
            errorCode = 'INVALID_INVITE';
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

      // Defence-in-depth shape check. `postFederationEventSync` already
      // parsed via the schema, but assert the inviteCode lines up with the
      // one we sent (a peer that returned a snapshot for a DIFFERENT code is
      // either buggy or hostile).
      const snapshot = result.payload.serverSnapshot;
      if (result.payload.inviteCode !== code) {
        return reply
          .code(502)
          .send(
            fail(
              'INTERNAL_ERROR',
              `home replied with a snapshot for a different invite (${result.payload.inviteCode})`,
            ),
          );
      }

      // 6) Mirror the snapshot.
      //
      // The transaction holds across createMirrorServer + N upsertMirrorChannel
      // + N addMirrorMember. The mirror service's resolveRemoteUser callback
      // delegates to the profile fetcher on cache miss, which runs OUTSIDE
      // the transaction (its own Prisma client, separate connection) — that's
      // intentional: it makes a network call. The committed RemoteUser row is
      // then visible to the in-transaction re-read under PG read-committed.
      const mirrorService = new FederationMirrorService({
        resolveRemoteUser: makeProfileBackedRemoteUserResolver(deps.profile),
      });

      let alreadyMirrored = false;
      let joinerAlreadyMember = false;

      let txOutput: { mirroredServerId: string };
      try {
        txOutput = await prisma.$transaction(async (tx) => {
        // Lookup the existing mirror, if any. Mirror server ids are equal to
        // the home's server id — see snapshot schema. So we key on
        // snapshot.serverId.
        const existingServer = await tx.server.findUnique({
          where: { id: snapshot.serverId },
          select: { id: true, originInstanceId: true },
        });

        if (existingServer) {
          alreadyMirrored = true;

          // Defence-in-depth — make sure the existing Server is actually a
          // mirror originating from THIS peer. A id-collision between a
          // local server and a remote mirror would surface here as a
          // mismatched originInstanceId; reject with 409 rather than
          // silently overwriting.
          if (existingServer.originInstanceId !== peer.id) {
            // Throw and translate below — keeps the route handler shape
            // consistent with the rest of the body.
            throw new MirrorOriginConflictError(snapshot.serverId);
          }

          // Is the joiner already a member? If so, nothing to do.
          const me = await tx.serverMember.findUnique({
            where: { serverId_userId: { serverId: snapshot.serverId, userId: joiner.id } },
            select: { userId: true },
          });
          if (me) {
            joinerAlreadyMember = true;
            return { mirroredServerId: snapshot.serverId };
          }

          // Add the joiner as a remote-style member (synthetic User row
          // already exists for them locally; the resolver fast-paths).
          // Note: the joiner is LOCAL on B — they are NOT a synthetic
          // remote-user. The mirror is on B, the joiner is on B, so adding
          // them is a normal `ServerMember.create` keyed on the joiner's
          // local User id (joiner.id).
          await tx.serverMember.create({
            data: { serverId: snapshot.serverId, userId: joiner.id },
          });
          return { snapshot, mirroredServerId: snapshot.serverId };
        }

        // Cold path — first time anyone on this instance accepts this
        // invite. Create the mirror server + channels + members from scratch.
        await mirrorService.createMirrorServer({
          tx,
          serverId: snapshot.serverId,
          originInstanceId: peer.id,
          ownerRemoteUserId: snapshot.ownerRemoteUserId,
          name: snapshot.name,
          description: snapshot.description,
          iconUrl: snapshot.iconUrl,
        });

        for (const channel of snapshot.channels) {
          // `federationMode` and `nsfw` have `.default()` on the schema,
          // which Zod surfaces as `optional` in the inferred type even
          // though the parser populates them on every call. Coalesce so
          // the mirror helper sees concrete values.
          await mirrorService.upsertMirrorChannel({
            tx,
            serverId: snapshot.serverId,
            originInstanceId: peer.id,
            channelId: channel.id,
            name: channel.name,
            type: channel.type,
            topic: channel.topic,
            position: channel.position,
            federationMode: channel.federationMode ?? 'inherit',
            nsfw: channel.nsfw ?? false,
          });
        }

        // Add every member in the snapshot. The owner was already inserted
        // by createMirrorServer; addMirrorMember is idempotent on the
        // (serverId, userId) composite, so a duplicate quietly succeeds.
        // Every member here is a remote user on the home peer — even the
        // owner. The joiner does NOT appear in the snapshot the home sends
        // back; they are a brand-new ServerMember we add explicitly below.
        for (const member of snapshot.members) {
          await mirrorService.addMirrorMember(
            tx,
            snapshot.serverId,
            member.remoteUserId,
            member.displayName,
          );
        }

        // Finally, add the joiner as a local ServerMember. The mirror
        // service's addMirrorMember is designed for REMOTE users (it
        // synthesises a User row); the joiner is local, so we do a direct
        // ServerMember.create.
        await tx.serverMember.create({
          data: { serverId: snapshot.serverId, userId: joiner.id },
        });

        return { snapshot, mirroredServerId: snapshot.serverId };
      });
      } catch (err) {
        if (err instanceof MirrorOriginConflictError) {
          return reply.code(409).send(fail('CONFLICT', err.message));
        }
        throw err;
      }

      // 7) Post-commit gateway broadcast. The user-targeted SERVER_ADD lets
      //    the joiner's sidebar splice the new Server in without a full
      //    READY refresh. We reload the Server row so the broadcast carries
      //    the canonical wire shape (with the defaultRoleId etc.).
      const serverRow = await prisma.server.findUnique({
        where: { id: txOutput.mirroredServerId },
        // P4-16 — pull `originInstance.host` so the post-commit SERVER_ADD
        // carries the wire-shape `originInstanceHost`, letting the joiner's
        // sidebar render the federated-den badge immediately on splice-in.
        include: { originInstance: { select: { host: true } } },
      });
      if (serverRow) {
        gatewayBroker.publish({
          type: 'SERVER_ADD',
          userId: joiner.id,
          data: serializeServer(serverRow),
        });
      }

      // 8) Reply. Include `alreadyMember` so the client can choose a softer
      //    notification when re-accepting an invite.
      reply.code(200).send(
        ok({
          serverId: txOutput.mirroredServerId,
          mirrored: true,
          alreadyMember: alreadyMirrored && joinerAlreadyMember,
        }),
      );
    },
  );

}

class MirrorOriginConflictError extends Error {
  constructor(serverId: string) {
    super(
      `local server ${serverId} exists but does not originate from the expected peer — refusing to overwrite`,
    );
    this.name = 'MirrorOriginConflictError';
  }
}
