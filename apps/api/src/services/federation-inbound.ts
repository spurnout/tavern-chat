/**
 * Federation Phase 3 — inbound `POST /_federation/event` dispatcher.
 *
 * Responsibilities (in order):
 *   1. Validate that the envelope is shaped enough to extract `fromInstance` +
 *      `eventType` + `nonce` (so we can fail fast before any signature work).
 *   2. Look up the `RemoteInstance` keyed on `fromInstance`. Peer MUST be in
 *      `status='peered'`. Anything else → 403 (`peer not peered`).
 *   3. Resolve the author's public key. We try `RemoteUser.publicKey` first; on
 *      cache miss we call `FederationProfileService.fetchRemoteProfile` which
 *      hits the peer's `.well-known` + posts a `profile.request`. The cache
 *      lookup uses the qualified id pulled out of the payload, so we have to
 *      peek at the (validated-shape but not yet signature-checked) payload to
 *      get it. That peek is by EVENT TYPE — each handler declares where the
 *      author id lives in its payload (see `extractAuthorRemoteUserId`).
 *   4. Call `verifyTwoLayerMessageEnvelope` with BOTH keys + the appropriate
 *      Zod schema. This is the single point that checks both signatures, the
 *      replay window, the payload shape, and the timestamps. On instance-
 *      signature failure ONLY, retry with the peer's `previousInstanceKey`
 *      (rotation overlap) before declaring `bad_signature`.
 *   5. Open a transaction; insert the envelope-log row FIRST. The
 *      `unique(peerInstanceId, nonce)` constraint is the replay protection —
 *      a duplicate raises Prisma `P2002` which we translate to 409.
 *   6. Dispatch to the event-type handler INSIDE the transaction. The handler
 *      does all its writes via the transactional `tx` client, so if it fails
 *      for an unrecoverable reason the envelope-log insert rolls back too —
 *      otherwise the peer's retry would collide with the unique nonce and
 *      the message would be permanently lost.
 *   7. After the transaction commits, run the handler's `postCommit` hook —
 *      gateway broadcasts and `RemoteUser.lastSeenAt` cache touch. Both
 *      MUST be outside the transaction so clients never see an event for a
 *      row that rolled back, and the cache touch survives rollbacks.
 *
 * Why a dispatcher map: P3-8 (message.update + message.delete) and P3-9
 * (reaction.add + reaction.remove) both register handlers by adding a key to
 * `HANDLERS`. The route shell, signature verification, peer lookup, and
 * envelope-log write all stay in this file — they're not duplicated per
 * event type. As of P3-8 the map carries `message.create`, `message.update`,
 * and `message.delete`; reactions land in P3-9.
 *
 * Critical: this module is INBOUND-ONLY. It never calls `fanOutMessageCreate`
 * or any other outbound helper. There is no message relay in Phase 3 — every
 * peer receives the envelope directly from the home instance. The
 * `originInstanceId != null` marker on the persisted Message row is what
 * distinguishes a federated row from a local one, and the outbound fan-out
 * gate in `routes/messages.ts` is keyed on the local create route, never on
 * an inbound persist.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma as defaultPrisma } from '@tavern/db';
import {
  canonicalize,
  verifyTwoLayerMessageEnvelope,
  type FederationKeyStore,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import {
  channelCreatePayloadSchema,
  channelDeletePayloadSchema,
  channelUpdatePayloadSchema,
  ENVELOPE_EVENT_TYPES,
  type EnvelopeEventType,
  memberAddPayloadSchema,
  memberJoinRequestPayloadSchema,
  memberJoinedPayloadSchema,
  memberLeavePayloadSchema,
  memberRemovePayloadSchema,
  messageCreatePayloadSchema,
  messageDeletePayloadSchema,
  messageUpdatePayloadSchema,
  reactionAddPayloadSchema,
  reactionRemovePayloadSchema,
  serverUpdatePayloadSchema,
  type ChannelCreatePayload,
  type ChannelDeletePayload,
  type ChannelUpdatePayload,
  type MemberAddPayload,
  type MemberJoinRequestPayload,
  type MemberJoinedPayload,
  type MemberLeavePayload,
  type MemberRemovedPayload,
  type MemberRemovePayload,
  type MessageCreatePayload,
  type MessageDeletePayload,
  type MessageUpdatePayload,
  type ReactionAddPayload,
  type ReactionRemovePayload,
  type ServerSnapshot,
  type ServerUpdatePayload,
  ulid,
} from '@tavern/shared';
import { z } from 'zod';
import { ensureUserForRemoteUser } from './remote-user-upsert.js';
import {
  computeEffectiveFederation,
  fanOutMemberAdd,
  fanOutMemberRemove,
  fanOutMessageCreateRelay,
  type FederationMode,
} from './federation-outbox.js';
import type { QueueClient } from './queues.js';
import {
  buildSignedEnvelope,
  type SignedEnvelope,
} from './federation-envelopes.js';
import { deriveServerIconUrl } from './federation-invite-preview.js';
import { FederationMirrorService } from './federation-mirror.js';
import { FederationProfileService } from './federation-profile.js';
import { makeProfileBackedRemoteUserResolver } from './mirror-remote-user-resolver.js';
import { gatewayBroker } from './gateway-broker.js';
import {
  serializeChannel,
  serializeMessage,
  serializeServer,
} from '../lib/serializers.js';

/**
 * Why this is a class+exception instead of a tagged union: the route layer
 * just wants a `{ status, body }` to render, and every failure mode in this
 * file has both. Throwing keeps the happy path readable and lets the
 * dispatcher reuse the same exit shape for any handler.
 */
export type InboundErrorCode =
  | 'bad_envelope' // 400 — malformed JSON / fails Zod / missing fields
  | 'unknown_peer' // 403 — no RemoteInstance for fromInstance
  | 'peer_not_peered' // 403 — RemoteInstance exists but status != 'peered'
  | 'bad_signature' // 401 — instance OR user signature verify failed
  | 'unauthorized_leave' // 401 — member.leave envelope signed by someone other than the leaver
  | 'replay' // 409 — (peerInstanceId, nonce) already logged
  | 'unknown_channel' // 404 — payload references a channelId we don't have
  | 'unknown_message' // 404 — payload references a messageId we don't have
  | 'unknown_invite' // 404 — payload.inviteCode not found / not federated
  | 'unknown_mirror_server' // 404 — payload.serverId not present as a mirror locally
  | 'unknown_member' // 404 — payload references a leaverRemoteUserId we don't have a User row for
  | 'invite_no_longer_valid' // 410 — invite is revoked / expired / exhausted
  | 'federation_off' // 403 — channel federation effective state is OFF
  | 'not_a_member' // 403 — author isn't a member of channel's server
  | 'not_origin' // 403 — sending peer is not the origin instance of the mirror
  | 'forbidden' // 403 — actor doesn't match expected role (e.g. non-author edit)
  | 'not_implemented'; // 501 — event type recognised by schema, handler is TBD

export class FederationInboundError extends Error {
  constructor(
    public readonly code: InboundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FederationInboundError';
  }
}

export interface FederationInboundServiceOptions {
  profile: FederationProfileService;
  /**
   * Instance keystore — only required for handlers that produce a signed
   * response envelope (P4-7 `member.join_request` returns a signed
   * `member.joined` envelope). Optional so older instantiations without
   * P4-7 still type-check, but `processEnvelope` will throw at build time
   * if a handler tries to set `responseEnvelopePayload` without keys.
   */
  keys?: FederationKeyStore;
  /**
   * Queue client for the P4-10 outbound `member.add` fan-out triggered by
   * the inbound `member.join_request` handler — A receives the request
   * from B, accepts it, and needs to tell every OTHER peered instance
   * (with a member in T) that the joiner is now in. Optional — when
   * omitted (e.g. tests that don't exercise membership fan-out), the
   * handler short-circuits the post-commit fan-out call.
   */
  queues?: QueueClient;
  /**
   * Instance-level FEDERATION_ENABLED flag — defence-in-depth gate
   * threaded through to the fan-out helper. When `false` the helper logs
   * a warning and returns without enqueuing.
   */
  federationEnabledOnInstance?: boolean;
  /**
   * Optional structured logger for handler-side fan-out failures (P4-10).
   * The dispatcher itself never logs — failures are thrown as
   * `FederationInboundError` and rendered by the route. The fan-out
   * helpers, however, are best-effort (one bad peer mustn't strand the
   * others) and need a place to surface per-peer failures. Falls back to
   * a no-op when undefined so unit tests don't need to wire a logger.
   */
  log?: FastifyBaseLogger;
  /**
   * This instance's federation host (e.g. `a.example`). Required when
   * handlers produce signed response envelopes (used as `fromInstance`).
   */
  selfHost?: string;
  prisma?: PrismaClient;
}

export interface ProcessEnvelopeResult {
  status: number;
  body?: unknown;
}

/**
 * No-op fallback logger so handler-internal best-effort code paths (P4-10
 * fan-out errors) can call `.warn` / `.error` even when the service was
 * constructed without one. Type-compatible with the subset of
 * `FastifyBaseLogger` the fan-out helpers consume.
 */
const noopLogger: FastifyBaseLogger = {
  level: 'silent',
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child: () => noopLogger,
} as unknown as FastifyBaseLogger;

export class FederationInboundService {
  private readonly prisma: PrismaClient;
  private readonly profile: FederationProfileService;
  private readonly keys: FederationKeyStore | null;
  private readonly selfHost: string | null;
  /**
   * P4-10 — wired through to the `member.join_request` handler so the
   * post-commit hook can fan `member.add` to peers OTHER than the
   * joiner's home. Optional — handlers fall back to a no-op fan-out when
   * unset (mirrors the route-layer pattern where `queues`/`selfHost` are
   * gating the fan-out, not the local persist).
   */
  private readonly queues: QueueClient | null;
  private readonly federationEnabledOnInstance: boolean;
  private readonly log: FastifyBaseLogger;

  constructor(opts: FederationInboundServiceOptions) {
    this.prisma = opts.prisma ?? defaultPrisma;
    this.profile = opts.profile;
    this.keys = opts.keys ?? null;
    this.selfHost = opts.selfHost ?? null;
    this.queues = opts.queues ?? null;
    this.federationEnabledOnInstance = opts.federationEnabledOnInstance ?? false;
    this.log = opts.log ?? noopLogger;
  }

  /**
   * Single entry point for `POST /_federation/event`. Verifies the envelope,
   * logs it for replay protection, and dispatches to the per-event-type
   * handler. Throws `FederationInboundError` for every recoverable failure;
   * the route translates the code to a status code.
   */
  async processEnvelope(body: unknown): Promise<ProcessEnvelopeResult> {
    const preCheck = parseEnvelopePrelude(body);

    const peer = await this.prisma.remoteInstance.findUnique({
      where: { host: preCheck.fromInstance },
    });
    if (!peer) {
      throw new FederationInboundError(
        'unknown_peer',
        `host ${preCheck.fromInstance} is not a known peer`,
      );
    }
    if (peer.status !== 'peered') {
      throw new FederationInboundError(
        'peer_not_peered',
        `peer ${preCheck.fromInstance} is ${peer.status}, not peered`,
      );
    }

    // Reject unimplemented event types BEFORE we do signature work. We still
    // need the peer + envelope-shape check above so a bogus envelope from an
    // unknown peer can't probe which event types exist on this server.
    const handler = HANDLERS[preCheck.eventType];
    if (!handler) {
      throw new FederationInboundError(
        'not_implemented',
        `event type ${preCheck.eventType} is not implemented yet`,
      );
    }

    // Resolve the author's public key. Two-layer verification needs BOTH
    // keys in one call, so we look up RemoteUser by the payload's author id
    // before calling verify. The payload at this point has only passed the
    // envelope-prelude shape check — it isn't signature-verified yet, but
    // pulling a `string` field out of it for the cache lookup is safe (the
    // worst case is a cache miss + a profile fetch from the peer).
    //
    // Two extraction strategies: synchronous (the actor is named in the
    // payload — every message/reaction handler) and async DB-backed (the
    // actor is the mirror Server's owner — the four P4-8 mirror handlers).
    // The async resolver runs BEFORE crypto and is allowed to throw
    // `FederationInboundError` for early-fail conditions like
    // `unknown_mirror_server` / `not_origin` — those naturally belong here
    // because they don't depend on signature verification.
    let authorRemoteUserId: string | null;
    if (handler.resolveAuthorRemoteUserId) {
      authorRemoteUserId = await handler.resolveAuthorRemoteUserId({
        payload: preCheck.payload,
        peer: { id: peer.id, host: peer.host },
        prisma: this.prisma,
      });
    } else if (handler.extractAuthorRemoteUserId) {
      authorRemoteUserId = handler.extractAuthorRemoteUserId(preCheck.payload);
    } else {
      // Defence-in-depth: a handler that registers neither is a wiring bug.
      throw new Error(
        `handler for ${preCheck.eventType} declares neither extractAuthorRemoteUserId nor resolveAuthorRemoteUserId`,
      );
    }
    if (!authorRemoteUserId) {
      throw new FederationInboundError(
        'bad_envelope',
        'envelope payload missing author identifier',
      );
    }

    let remoteUserRow = await this.prisma.remoteUser.findUnique({
      where: { remoteUserId: authorRemoteUserId },
    });
    if (!remoteUserRow) {
      // Cache miss — let the profile service fetch + upsert. It validates
      // the response signature against the peer's published instance key.
      try {
        await this.profile.fetchRemoteProfile(authorRemoteUserId);
      } catch (err) {
        // Profile fetch is the only outbound call here. If it fails, the
        // envelope can't be verified — treat as bad_envelope so the peer
        // sees a 400 (not a 401 — the issue is upstream, not crypto).
        const msg = err instanceof Error ? err.message : String(err);
        throw new FederationInboundError(
          'bad_envelope',
          `could not resolve author public key for ${authorRemoteUserId}: ${msg}`,
        );
      }
      remoteUserRow = await this.prisma.remoteUser.findUnique({
        where: { remoteUserId: authorRemoteUserId },
      });
      if (!remoteUserRow) {
        // The profile service either threw above or upserted; if it didn't
        // upsert, something inconsistent happened. Defensive guard.
        throw new FederationInboundError(
          'bad_envelope',
          `author ${authorRemoteUserId} could not be cached`,
        );
      }
    }

    // Verify against the peer's CURRENT instance key first.
    let verified = verifyTwoLayerMessageEnvelope({
      envelope: body,
      peerInstancePublicKeyRaw: Buffer.from(peer.instanceKey),
      authorPublicKeyRaw: Buffer.from(remoteUserRow.publicKey),
      payloadSchema: handler.payloadSchema,
    });
    // Rotation-overlap fallback: if verification failed SPECIFICALLY because
    // the instance signature didn't match (user signature + envelope shape
    // both fine) AND the peer has a `previousInstanceKey` cached from a prior
    // rotation, retry with the previous key. The fallback is intentionally
    // scoped to instance-signature failures — a user-signature failure or an
    // envelope-shape failure must NOT trigger the retry, because the
    // previous-key window exists to handle peer rotation, not to disguise
    // other classes of failure.
    if (
      !verified.ok &&
      peer.previousInstanceKey &&
      /instance signature does not verify/i.test(verified.reason)
    ) {
      verified = verifyTwoLayerMessageEnvelope({
        envelope: body,
        peerInstancePublicKeyRaw: Buffer.from(peer.previousInstanceKey),
        authorPublicKeyRaw: Buffer.from(remoteUserRow.publicKey),
        payloadSchema: handler.payloadSchema,
      });
    }
    if (!verified.ok) {
      // verify returns three flavours of failure: (a) "envelope shape
      // invalid" / "notBefore in the future" / "notAfter expired" — those
      // are 400-bad-envelope problems (the peer sent us garbage or a stale
      // event); (b) "user signature does not verify" / "instance signature
      // does not verify" — those are 401-bad-signature. Map by the prefix
      // because the verify helper returns a `reason` string.
      const reason = verified.reason;
      const isSigFailure = /signature does not verify/i.test(reason);
      throw new FederationInboundError(
        isSigFailure ? 'bad_signature' : 'bad_envelope',
        reason,
      );
    }

    // Transactional envelope log + handler side-effects. The log insert is
    // the FIRST write inside the transaction — its unique(peerInstanceId,
    // nonce) constraint provides replay protection. If the handler fails
    // for an unrecoverable reason (FK violation on replyToMessageId, etc.),
    // the log row rolls back with the rest of the transaction, so the peer
    // can retry without permanently losing the message.
    //
    // What stays OUTSIDE the transaction: `remoteUser.lastSeenAt` updates
    // (cache touch, best-effort), gateway broadcasts (only fired AFTER the
    // commit so clients never see an event for a rolled-back row).
    const payloadHash = createHash('sha256')
      .update(canonicalize(verified.envelope.payload as unknown))
      .digest();

    let result: ProcessEnvelopeResult;
    let postCommit: PostCommitAction | null = null;
    let responseEnvelopePayload:
      | { eventType: EnvelopeEventType; payload: unknown }
      | null = null;
    try {
      const txOutput = await this.prisma.$transaction(async (tx) => {
        await tx.federationEnvelopeLog.create({
          data: {
            id: ulid(),
            direction: 'inbound',
            peerInstanceId: peer.id,
            eventType: verified.envelope.eventType,
            payloadHash,
            nonce: verified.envelope.nonce,
            notBefore: new Date(verified.envelope.notBefore),
            notAfter: new Date(verified.envelope.notAfter),
            status: 'accepted',
            processedAt: new Date(),
          },
        });
        return handler.handle({
          envelope: verified.envelope,
          payload: verified.payload,
          peer,
          remoteUser: remoteUserRow,
          tx,
          selfHost: this.selfHost,
          queues: this.queues,
          federationEnabledOnInstance: this.federationEnabledOnInstance,
          log: this.log,
          profile: this.profile,
        });
      });
      result = txOutput.result;
      postCommit = txOutput.postCommit ?? null;
      responseEnvelopePayload = txOutput.responseEnvelopePayload ?? null;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // The unique-constraint failure is the log row in the vast majority
        // of cases (replay). Any other P2002 (e.g. message id reuse with a
        // different nonce — see handler dedupe path) is handled inside the
        // handler itself, so reaching here means the log row collided.
        throw new FederationInboundError(
          'replay',
          'nonce already seen for this peer',
        );
      }
      throw err;
    }

    // Post-commit side effects. Gateway broadcasts and the lastSeenAt touch
    // MUST happen after the transaction commits, so:
    //   - clients never see an event for a row that rolled back;
    //   - the lastSeenAt cache touch survives a transaction rollback (it's
    //     not authoritative state — we still want to record that we heard
    //     from this peer even if message persistence had to retry).
    if (postCommit) {
      await postCommit(this.prisma);
    }

    // P4-7: response-envelope wrapping. When the handler returned a
    // `responseEnvelopePayload`, sign a single-layer envelope with this
    // instance's key and use it as the HTTP response body. The signing
    // happens AFTER the transaction commits because the snapshot fields
    // (member roster etc.) reflect committed state, and we don't want to
    // emit a signed envelope describing rows that could roll back.
    if (responseEnvelopePayload) {
      if (!this.keys || !this.selfHost) {
        // Configuration bug — a handler asked for a signed response but the
        // service wasn't wired with keys+selfHost. Crash loudly so the gap
        // is caught at startup of any deployment that adds a handler.
        throw new Error(
          'FederationInboundService: handler returned responseEnvelopePayload ' +
            'but service was constructed without keys/selfHost',
        );
      }
      const signed: SignedEnvelope<unknown> = buildSignedEnvelope({
        eventType: responseEnvelopePayload.eventType,
        fromInstance: this.selfHost,
        toInstance: verified.envelope.fromInstance,
        payload: responseEnvelopePayload.payload,
        sign: (bytes) => this.keys!.sign(bytes),
      });
      return { status: result.status, body: signed };
    }
    return result;
  }
}

// --- handler map -------------------------------------------------------------

/**
 * Work the handler wants to run AFTER the transaction commits — gateway
 * broadcasts, cache touches that should survive a rollback, etc.
 *
 * It receives the non-transactional `PrismaClient` because by definition it
 * runs after the surrounding `$transaction` has resolved; the `tx` handle
 * is no longer valid there.
 */
export type PostCommitAction = (prisma: PrismaClient) => Promise<void>;

/**
 * What every handler returns from inside the transaction. The HTTP shape
 * `result` is what the route renders; `postCommit` is anything that has to
 * happen AFTER `$transaction` resolves (gateway broker publishes, the
 * `lastSeenAt` cache touch). Splitting them lets `processEnvelope` keep the
 * "fire side effects only on commit" rule in one place — handlers don't
 * have to know they're being run inside a transaction.
 *
 * `responseEnvelopePayload` (P4-7) — when set, the dispatcher wraps the
 * payload in a single-layer signed envelope (signed by THIS instance's
 * instance key) and uses it as the HTTP response body. Used by
 * `member.join_request` to return a `member.joined` envelope carrying the
 * server snapshot. Mutually exclusive with `result.body`: when the
 * dispatcher constructs the envelope it overrides whatever `result.body`
 * the handler set, so handlers should leave `result.body` undefined.
 */
export interface HandlerOutput {
  result: ProcessEnvelopeResult;
  postCommit?: PostCommitAction;
  responseEnvelopePayload?: {
    eventType: EnvelopeEventType;
    payload: unknown;
  };
}

/**
 * A handler bundles three things: the payload schema (passed into
 * `verifyTwoLayerMessageEnvelope`), an extractor for the author id (used for
 * the public-key cache lookup before signature verification), and the
 * side-effect step that runs after the envelope is fully verified + logged.
 *
 * Adding a new event type in P3-8 / P3-9 means adding one entry here. The
 * route shell, signature verification, and replay-log write all stay in
 * `processEnvelope` and don't need to be touched.
 *
 * Handlers receive a transactional `tx` client, not the bare `PrismaClient`.
 * Every DB write the handler performs MUST go through `tx` so that a failure
 * partway through rolls back the envelope-log insert too — otherwise the
 * peer's retry would collide with the unique nonce and the message would be
 * permanently lost.
 */
interface InboundHandler<TSchema extends z.ZodTypeAny> {
  payloadSchema: TSchema;
  /**
   * Cheap structural extractor — pulls the author's qualified remote user id
   * directly out of the payload. Used when the payload itself names the
   * actor (every message/reaction envelope; `member.join_request`'s
   * `joinerRemoteUserId`).
   *
   * Mutually exclusive with `resolveAuthorRemoteUserId` — set exactly one.
   * Both null/undefined → bad_envelope.
   */
  extractAuthorRemoteUserId?: (payload: unknown) => string | null;
  /**
   * Async DB-backed resolver — used when the payload does NOT name an
   * actor and the implicit signer is derived from local state (the four
   * P4-8 mirror handlers: the implicit signer is the mirror Server's
   * owner remote user). Runs BEFORE signature verification, so failing
   * fast here also gates the user-key cache lookup.
   *
   * The resolver MAY throw `FederationInboundError` (e.g. for
   * `unknown_mirror_server` or `not_origin`); the dispatcher will
   * propagate the error code to the route as-is, which is the natural
   * place to surface "no such mirror" before any crypto work.
   *
   * Returning `null` from a resolver is bad_envelope (same as
   * `extractAuthorRemoteUserId`); throw an `InboundError` with a more
   * specific code when one is appropriate.
   */
  resolveAuthorRemoteUserId?: (input: {
    payload: unknown;
    peer: { id: string; host: string };
    prisma: PrismaClient;
  }) => Promise<string | null>;
  handle: (input: {
    envelope: TwoLayerSignedEnvelope<z.infer<TSchema>>;
    payload: z.infer<TSchema>;
    peer: { id: string; host: string };
    remoteUser: NonNullable<
      Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
    >;
    tx: Prisma.TransactionClient;
    /**
     * This instance's federation host (e.g. `a.example`). Forwarded from
     * the service constructor; only the `member.join_request` handler uses
     * it (to build the qualified id for local members in the snapshot
     * roster). Other handlers can ignore it.
     */
    selfHost: string | null;
    /**
     * Optional queue client — only the P4-7 / P4-10 `member.join_request`
     * handler uses it (post-commit `member.add` fan-out to other peers).
     * Other handlers ignore it.
     */
    queues: QueueClient | null;
    /**
     * Instance-level FEDERATION_ENABLED gate — same use as `queues`,
     * threaded to the fan-out helper for defence-in-depth.
     */
    federationEnabledOnInstance: boolean;
    /**
     * Logger for handler-internal best-effort failures (e.g. P4-10 fan-out
     * enqueue errors). Defaults to a no-op when the service is constructed
     * without one.
     */
    log: FastifyBaseLogger;
    /**
     * Profile service — used by the P4-11 `member.add` handler to build a
     * production `ResolveRemoteUserFn` for `addMirrorMember`. The mirror
     * helper needs to materialise (or look up) the joiner's RemoteUser row;
     * on cache miss it falls back to `fetchRemoteProfile`. Other handlers
     * ignore it.
     */
    profile: FederationProfileService;
  }) => Promise<HandlerOutput>;
}

const HANDLERS: Partial<Record<EnvelopeEventType, InboundHandler<z.ZodTypeAny>>> = {
  'message.create': {
    payloadSchema: messageCreatePayloadSchema,
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      // Cheap structural check — full schema validation happens later, this
      // is just to get an id for the cache lookup.
      const v = (payload as { authorRemoteUserId?: unknown } | null)
        ?.authorRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleMessageCreate as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'message.update': {
    payloadSchema: messageUpdatePayloadSchema,
    // Both update and delete payloads carry an actor id, but the field
    // names differ (`authorRemoteUserId` vs `actorRemoteUserId`) because
    // Phase 7 will introduce moderator deletes — the deleter isn't always
    // the author. Each handler extracts from its own field.
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      const v = (payload as { authorRemoteUserId?: unknown } | null)
        ?.authorRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleMessageUpdate as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'message.delete': {
    payloadSchema: messageDeletePayloadSchema,
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      const v = (payload as { actorRemoteUserId?: unknown } | null)
        ?.actorRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleMessageDelete as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'reaction.add': {
    payloadSchema: reactionAddPayloadSchema,
    // Both reaction payloads carry the actor under `actorRemoteUserId` — the
    // reactor isn't necessarily the message author (anyone can react).
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      const v = (payload as { actorRemoteUserId?: unknown } | null)
        ?.actorRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleReactionAdd as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'reaction.remove': {
    payloadSchema: reactionRemovePayloadSchema,
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      const v = (payload as { actorRemoteUserId?: unknown } | null)
        ?.actorRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleReactionRemove as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'member.join_request': {
    payloadSchema: memberJoinRequestPayloadSchema,
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      // The joiner IS the author of the user-layer signature on this
      // envelope. They aren't a local user on THIS instance — they live
      // on the peer that sent the envelope.
      const v = (payload as { joinerRemoteUserId?: unknown } | null)
        ?.joinerRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleMemberJoinRequest as InboundHandler<z.ZodTypeAny>['handle'],
  },
  // P4-8 — mirror Server/Channel lifecycle. The user-layer signer is
  // implicit (the mirror Server's owner on the origin peer), so each of
  // these uses `resolveAuthorRemoteUserId` to look up the owner via the
  // mirror row instead of a payload field. Sender check (`fromInstance`
  // == mirror.originInstance.host) and mirror existence check live in
  // the resolver too — failing fast there avoids any crypto work for an
  // unknown / non-origin envelope.
  'server.update': {
    payloadSchema: serverUpdatePayloadSchema,
    resolveAuthorRemoteUserId: (input) => resolveMirrorOwner(input, 'serverId'),
    handle: handleServerUpdate as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'channel.create': {
    payloadSchema: channelCreatePayloadSchema,
    resolveAuthorRemoteUserId: (input) => resolveMirrorOwner(input, 'serverId'),
    handle: handleChannelCreate as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'channel.update': {
    payloadSchema: channelUpdatePayloadSchema,
    resolveAuthorRemoteUserId: (input) => resolveMirrorOwner(input, 'serverId'),
    handle: handleChannelUpdate as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'channel.delete': {
    payloadSchema: channelDeletePayloadSchema,
    resolveAuthorRemoteUserId: (input) => resolveMirrorOwner(input, 'serverId'),
    handle: handleChannelDelete as InboundHandler<z.ZodTypeAny>['handle'],
  },
  // P4-11 — mirror membership updates. Same author resolver pattern as
  // the P4-8 lifecycle handlers: the signer is implicitly the mirror
  // Server's owner on the origin peer (the home authority delivering the
  // membership change), so each uses `resolveMirrorOwner`. The payload's
  // `memberRemoteUserId` is the SUBJECT of the change (the joining /
  // leaving member), not the author of the envelope.
  'member.add': {
    payloadSchema: memberAddPayloadSchema,
    resolveAuthorRemoteUserId: (input) => resolveMirrorOwner(input, 'serverId'),
    handle: handleMemberAdd as InboundHandler<z.ZodTypeAny>['handle'],
  },
  'member.remove': {
    payloadSchema: memberRemovePayloadSchema,
    resolveAuthorRemoteUserId: (input) => resolveMirrorOwner(input, 'serverId'),
    handle: handleMemberRemove as InboundHandler<z.ZodTypeAny>['handle'],
  },
  // P4-12 — voluntary leave from a remote user. The leaver is the author of
  // the user-layer signature (only the user themselves can request their own
  // leave). The dispatcher resolves the public key from
  // `payload.leaverRemoteUserId`, and the handler enforces that the verified
  // remoteUser matches that same id.
  'member.leave': {
    payloadSchema: memberLeavePayloadSchema,
    extractAuthorRemoteUserId: (payload: unknown): string | null => {
      const v = (payload as { leaverRemoteUserId?: unknown } | null)
        ?.leaverRemoteUserId;
      return typeof v === 'string' ? v : null;
    },
    handle: handleMemberLeave as InboundHandler<z.ZodTypeAny>['handle'],
  },
  // Phase 1-2 envelopes (peering.*, profile.*) flow through their own
  // dedicated routes and never reach this handler map. They are intentionally
  // omitted; an attacker reusing those event types here gets a 501.
  //
  // `member.joined` (P4-7) and `member.removed` (P4-12, see P4-15) are also
  // intentionally omitted — they are SINGLE-LAYER signed envelopes returned as
  // the synchronous HTTP response to a `member.join_request` / `member.leave`
  // POST. The originating peer's calling code consumes the response inline
  // (via `postFederationEventSync` with an `expectedResponseSchema`), so they
  // never reach this dispatcher on the happy path. The two-layer dispatcher
  // also literally cannot verify them (no user-layer signature is present), so
  // even if a peer mistakenly sent one to `/_federation/event` it would fail
  // before reaching a handler. The 501 returned by the HANDLERS-miss path is
  // the correct response for that misuse. If we ever need async / out-of-band
  // delivery of these acks, the dispatcher would have to grow single-layer
  // verification — tracked as a follow-up in `docs/federation-followups.md`.
};

// Sanity check at startup that every handler key is a valid EnvelopeEventType
// (the `Partial<Record<>>` above gives us that statically).
for (const key of Object.keys(HANDLERS)) {
  if (!(ENVELOPE_EVENT_TYPES as readonly string[]).includes(key)) {
    throw new Error(`HANDLERS contains unknown event type: ${key}`);
  }
}

// --- message.create handler --------------------------------------------------

async function handleMessageCreate(input: {
  envelope: TwoLayerSignedEnvelope<MessageCreatePayload>;
  payload: MessageCreatePayload;
  peer: { id: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
  /**
   * Wired through from the dispatcher (see `FederationInboundService.processEnvelope`).
   * The P4-13 relay needs them to enqueue forwarded envelopes to OTHER peers
   * when this instance is the home of T. All four are optional in the type
   * (other handlers ignore them), but the relay only fires when ALL of
   * `selfHost`, `queues`, and `federationEnabledOnInstance === true` are
   * present — defence-in-depth gates so a partial federation wiring can
   * never silently start emitting envelopes.
   */
  selfHost: string | null;
  queues: QueueClient | null;
  federationEnabledOnInstance: boolean;
  log: FastifyBaseLogger;
}): Promise<HandlerOutput> {
  const { envelope, payload, peer, remoteUser, tx } = input;

  // Channel must exist locally. Phase 3 requires the receiving instance to
  // have a mirror Channel row already; Phase 4 will introduce federated
  // invites that create the row on-demand.
  //
  // We also pull `server.originInstanceId` here so the postCommit relay gate
  // (P4-13) can tell whether THIS instance is the HOME of T (null) or a
  // mirror (non-null). Only homes relay — mirrors would forward back to the
  // home and cause a loop / wasted work.
  const channel = await tx.channel.findUnique({
    where: { id: payload.channelId },
    select: {
      id: true,
      serverId: true,
      federationMode: true,
      server: {
        select: { federationEnabled: true, originInstanceId: true },
      },
    },
  });
  if (!channel) {
    throw new FederationInboundError(
      'unknown_channel',
      `channel ${payload.channelId} not found on this instance`,
    );
  }

  // Effective federation state for this channel. Mirrors the outbound gate
  // in `routes/messages.ts` so the receiver and the sender agree on which
  // channels accept federated content.
  const effective = computeEffectiveFederation(
    channel.server?.federationEnabled ?? false,
    channel.federationMode as FederationMode,
  );
  if (!effective) {
    throw new FederationInboundError(
      'federation_off',
      `federation is disabled for channel ${payload.channelId}`,
    );
  }

  // The author must already be a member of this channel's server. The
  // outbound fan-out side only sends to peers that have a member in the
  // server (see findPeersWithRemoteMembers); the inbound side enforces the
  // symmetric invariant — "we don't accept content from a remote user we
  // haven't already invited into this room."
  //
  // `ensureUserForRemoteUser` typed as `PrismaClient`, but Prisma's runtime
  // accepts a TransactionClient anywhere a Client is expected as long as the
  // calls are on the model-delegate surface. We cast through unknown so the
  // function participates in this transaction.
  const localUser = await ensureUserForRemoteUser(
    remoteUser,
    tx as unknown as PrismaClient,
  );
  const member = await tx.serverMember.findUnique({
    where: { serverId_userId: { serverId: channel.serverId, userId: localUser.id } },
    select: { userId: true },
  });
  if (!member) {
    throw new FederationInboundError(
      'not_a_member',
      `author ${remoteUser.remoteUserId} is not a member of server ${channel.serverId}`,
    );
  }

  // Persist the Message row. We reuse the sender's id because ULIDs are
  // collision-resistant across instances and re-using the id lets edits +
  // deletes from the same peer find the local row without an extra lookup
  // table. If a row with that id already exists (concurrent envelopes,
  // replay after envelope-log cleared), short-circuit with the existing one.
  // The envelope-log row stays committed in that case — we DID accept this
  // envelope, it's just a duplicate of a message we already have.
  const existingMessage = await tx.message.findUnique({
    where: { id: payload.messageId },
    select: { id: true },
  });
  if (existingMessage) {
    return {
      result: {
        status: 200,
        body: { ok: true, data: { id: existingMessage.id, deduplicated: true } },
      },
      // Touch lastSeenAt even on idempotent path — the peer DID see this user
      // active when they signed the envelope. Done post-commit so it survives
      // any rollback.
      postCommit: async (prisma) => {
        await prisma.remoteUser.update({
          where: { id: remoteUser.id },
          data: { lastSeenAt: new Date() },
        });
      },
    };
  }

  // The "instance signature" (envelope.signature) is the canonical proof
  // that this content was signed by the origin instance. Persisting it on
  // the Message row lets us audit later — and lets future moderation hooks
  // verify the row without re-fetching the envelope.
  const signatureBytes = Buffer.from(envelope.signature, 'base64');
  const messageRow = await tx.message.create({
    data: {
      id: payload.messageId,
      serverId: channel.serverId,
      channelId: channel.id,
      authorId: localUser.id,
      type: 'default',
      content: payload.content,
      replyToMessageId: payload.replyToMessageId ?? null,
      createdAt: new Date(payload.createdAt),
      signature: signatureBytes,
      originInstanceId: peer.id,
    },
  });

  // Pull the full row shape `serializeMessage` expects. We need the relations
  // to render a wire DTO that matches the local CREATE path. Reads through
  // `tx` so we see the row we just inserted.
  const fullRow = await tx.message.findUniqueOrThrow({
    where: { id: messageRow.id },
    include: {
      attachments: { select: { id: true } },
      reactions: { select: { emoji: true, userId: true } },
      author: { select: { id: true, displayName: true, username: true } },
      poll: { select: { id: true } },
      replyTo: {
        select: {
          id: true,
          content: true,
          deletedAt: true,
          author: { select: { displayName: true } },
        },
      },
      forwardedFrom: {
        select: {
          id: true,
          channelId: true,
          author: { select: { displayName: true } },
        },
      },
    },
  });

  // viewerId='' because the gateway broker fans this out to many viewers —
  // any per-viewer state (reactions.me) is recomputed on the client. The
  // local create path passes the author's id, but here we have no single
  // viewer to serialise for.
  const dto = serializeMessage(fullRow, '');

  // P4-13 — home-instance relay gate. Decide BEFORE the postCommit closure
  // closes over scope so the criteria are explicit:
  //
  //   1. We are the HOME of T (`server.originInstanceId === null`). Mirrors
  //      do NOT relay — they would forward back to the home and waste work
  //      / risk loops. The receiving peer's mirror has its own
  //      `originInstanceId != null`, so this gate naturally fires only on
  //      the home and never propagates further than one hop.
  //   2. Server-level federation is on (defence in depth — the inbound
  //      handler already enforced effective federation per CHANNEL above,
  //      but the relay is about the SERVER's other peers, so we re-check
  //      the server flag itself).
  //   3. We have an outbound `queues` + `selfHost` wired (FEDERATION_ENABLED
  //      at the instance level — same gate the route layer applies).
  //
  // The actual relay (peer lookup + per-peer enqueue) lives in
  // `fanOutMessageCreateRelay`. Computing `shouldRelay` here keeps the
  // postCommit closure small and the gate visible.
  const isHome = channel.server?.originInstanceId == null;
  const serverFederated = channel.server?.federationEnabled === true;
  const shouldRelay =
    isHome &&
    serverFederated &&
    input.federationEnabledOnInstance &&
    input.queues != null &&
    input.selfHost != null;

  // Critically: we still do NOT call the local-author `fanOutMessageCreate`
  // here — that would re-sign on the original (remote) author's behalf,
  // which we can't do. The relay helper uses `preservedUserSignature` to
  // forward the ORIGINAL author signature unchanged.
  return {
    result: { status: 200, body: { ok: true, data: { id: messageRow.id } } },
    // Broadcast + lastSeenAt are post-commit. The broadcast happens only
    // after the message row is durable; the cache touch happens regardless
    // of the transaction outcome (it's not authoritative state).
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'MESSAGE_CREATE',
        serverId: channel.serverId,
        channelId: channel.id,
        data: dto,
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
      if (shouldRelay) {
        try {
          await fanOutMessageCreateRelay({
            queues: input.queues!,
            selfHost: input.selfHost!,
            serverId: channel.serverId,
            messageId: messageRow.id,
            // Pass the verified envelope's payload UNCHANGED. The user
            // signature was computed over the canonical bytes of THIS
            // exact payload object — any reformatting would invalidate
            // it on the receiving peers.
            originalPayload: envelope.payload,
            originalUserSignature: envelope.userSignature,
            // Drop the originating peer from the fan-out so we don't
            // echo the message back to whoever sent it.
            excludePeerInstanceId: peer.id,
            // For log correlation — the dispatcher will NOT call
            // userKeys.loadKeyFor on this (preservedUserSignature is set),
            // but operators searching by author id still want to find
            // the relayed jobs.
            authorUserId: localUser.id,
            log: input.log,
            federationEnabledOnInstance: input.federationEnabledOnInstance,
          });
        } catch (err: unknown) {
          // Best-effort — never let a relay failure break the local commit.
          // Mirrors the try/catch pattern used at every other federation
          // fan-out call site.
          const errObj = err instanceof Error ? err : new Error(String(err));
          input.log.warn(
            {
              err: errObj,
              messageId: messageRow.id,
              channelId: channel.id,
              serverId: channel.serverId,
            },
            'federation relay failed for inbound message.create',
          );
        }
      }
    },
  };
}

// --- message.update handler --------------------------------------------------

async function handleMessageUpdate(input: {
  envelope: TwoLayerSignedEnvelope<MessageUpdatePayload>;
  payload: MessageUpdatePayload;
  peer: { id: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  // Look up the target message. Must exist, must be locally non-deleted —
  // editing a tombstoned row makes no sense (the local DELETE handler gates
  // on `!message.deletedAt` for the same reason). Author check happens next.
  //
  // The channel + server federation flags come along on the same query so we
  // can apply the effective-federation gate before the author check. This
  // mirrors the outbound gate in `routes/messages.ts` and prevents an edit
  // envelope from mutating a row in a channel whose operator has since
  // flipped `federationMode='force_off'` (or whose server turned federation
  // off entirely). Without this gate the edit would land + broadcast even
  // though the receiver is no longer accepting federated content for the
  // channel — exactly the asymmetry the spec forbids.
  const existing = await tx.message.findUnique({
    where: { id: payload.messageId },
    select: {
      id: true,
      serverId: true,
      channelId: true,
      authorId: true,
      content: true,
      deletedAt: true,
      author: { select: { remoteUserId: true } },
      channel: {
        select: {
          federationMode: true,
          server: { select: { federationEnabled: true } },
        },
      },
    },
  });
  if (!existing || existing.deletedAt) {
    throw new FederationInboundError(
      'unknown_message',
      `message ${payload.messageId} not found on this instance`,
    );
  }
  if (!existing.channelId) {
    // Defence in depth — federation messages only flow through server
    // channels in Phase 3. A federated message targeting a DM would be a
    // protocol violation by the peer.
    throw new FederationInboundError(
      'unknown_message',
      `message ${payload.messageId} is not in a server channel`,
    );
  }

  // Effective federation check. Symmetric with `handleMessageCreate` and
  // `validateInboundReaction` — the inbound handler must enforce its own
  // gate so an operator flipping the channel off after the original CREATE
  // landed correctly rejects subsequent edits.
  const effective = computeEffectiveFederation(
    existing.channel?.server?.federationEnabled ?? false,
    (existing.channel?.federationMode ?? 'inherit') as FederationMode,
  );
  if (!effective) {
    throw new FederationInboundError(
      'federation_off',
      `federation is disabled for channel ${existing.channelId}`,
    );
  }

  // The author check: the envelope's actor MUST match the local Message
  // row's author remote user id. The signature already proved the actor IS
  // who they claim to be (user-layer sig against author's public key,
  // verified upstream by verifyTwoLayerMessageEnvelope); this check enforces
  // "actor must equal author" — i.e. only the original author may edit.
  // Moderator-driven federated edits are not honored in Phase 3 (Phase 7
  // deferral — `forbidden` here would be the right code if/when we extend
  // the spec to accept them).
  if (existing.author.remoteUserId !== remoteUser.remoteUserId) {
    throw new FederationInboundError(
      'forbidden',
      `actor ${remoteUser.remoteUserId} is not the author of message ${payload.messageId}`,
    );
  }

  // Append a MessageEdit history row BEFORE the content overwrite so a
  // failure rolls back the edit history along with the content change.
  // Mirrors the local PATCH handler at routes/messages.ts which records the
  // previous content before overwriting. The `editedBy` field stores the
  // local User row id mirroring the remote author — same row that owns the
  // message, so the history surface reads consistently with locally-authored
  // edits.
  if (existing.content !== payload.content) {
    await tx.messageEdit.create({
      data: {
        id: ulid(),
        messageId: existing.id,
        content: existing.content,
        editedBy: existing.authorId,
      },
    });
  }

  // Trust the envelope's editedAt as-is — the home instance signed it and
  // the envelope replay window keeps it close to now. If a peer ships a
  // wildly skewed editedAt, the local UI will sort it however the timestamp
  // says; the audit trail still has the envelope-log row with the receive
  // time.
  const editedAt = new Date(payload.editedAt);
  await tx.message.update({
    where: { id: existing.id },
    data: { content: payload.content, editedAt },
  });

  // Reload the full row for the gateway broadcast — needs the same include
  // shape `serializeMessage` expects. Done through `tx` so we see our own
  // write.
  const fullRow = await tx.message.findUniqueOrThrow({
    where: { id: existing.id },
    include: {
      attachments: { select: { id: true } },
      reactions: { select: { emoji: true, userId: true } },
      author: { select: { id: true, displayName: true, username: true } },
      poll: { select: { id: true } },
      replyTo: {
        select: {
          id: true,
          content: true,
          deletedAt: true,
          author: { select: { displayName: true } },
        },
      },
      forwardedFrom: {
        select: {
          id: true,
          channelId: true,
          author: { select: { displayName: true } },
        },
      },
    },
  });

  const dto = serializeMessage(fullRow, '');
  // Capture the channelId/serverId for the broadcast — non-null asserted
  // because we narrowed `existing.channelId` above.
  const channelId = existing.channelId;
  const serverId = existing.serverId;

  return {
    result: { status: 200, body: { ok: true, data: { id: existing.id } } },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'MESSAGE_UPDATE',
        serverId: serverId ?? undefined,
        channelId,
        data: dto,
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

// --- message.delete handler --------------------------------------------------

async function handleMessageDelete(input: {
  envelope: TwoLayerSignedEnvelope<MessageDeletePayload>;
  payload: MessageDeletePayload;
  peer: { id: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  // Pull channel + server federation flags alongside the target row so we
  // can apply the effective-federation gate before the author check.
  // Symmetric with `handleMessageCreate` and `validateInboundReaction` — if
  // an operator flips `federationMode='force_off'` after the original CREATE
  // committed, a subsequent delete envelope must NOT mutate the row.
  const existing = await tx.message.findUnique({
    where: { id: payload.messageId },
    select: {
      id: true,
      serverId: true,
      channelId: true,
      authorId: true,
      deletedAt: true,
      author: { select: { remoteUserId: true } },
      channel: {
        select: {
          federationMode: true,
          server: { select: { federationEnabled: true } },
        },
      },
    },
  });
  if (!existing) {
    throw new FederationInboundError(
      'unknown_message',
      `message ${payload.messageId} not found on this instance`,
    );
  }
  if (!existing.channelId) {
    throw new FederationInboundError(
      'unknown_message',
      `message ${payload.messageId} is not in a server channel`,
    );
  }

  // Effective federation check. See `handleMessageUpdate` for the rationale —
  // the gate lives on the inbound handler so a channel that's been turned
  // off after the original CREATE landed rejects subsequent mutations.
  const effective = computeEffectiveFederation(
    existing.channel?.server?.federationEnabled ?? false,
    (existing.channel?.federationMode ?? 'inherit') as FederationMode,
  );
  if (!effective) {
    throw new FederationInboundError(
      'federation_off',
      `federation is disabled for channel ${existing.channelId}`,
    );
  }

  // Idempotent delete: if the row is already soft-deleted, return 200
  // without touching anything. This matters when a peer retries a delete
  // (rare but possible — outbox retries, envelope replay window). The
  // unique nonce on the envelope log handles same-envelope retries; this
  // covers the case of a SECOND delete envelope (e.g. different nonce)
  // arriving after the first one committed.
  if (existing.deletedAt) {
    return {
      result: {
        status: 200,
        body: { ok: true, data: { id: existing.id, deduplicated: true } },
      },
      postCommit: async (prisma) => {
        await prisma.remoteUser.update({
          where: { id: remoteUser.id },
          data: { lastSeenAt: new Date() },
        });
      },
    };
  }

  // Author-only check: Phase 3 only accepts deletes signed by the original
  // author. Moderator-driven federated deletes are a Phase 7 problem —
  // letting peers' moderators delete content on this instance requires a
  // separate trust model. For now, treat any actor != original author as
  // forbidden.
  if (existing.author.remoteUserId !== remoteUser.remoteUserId) {
    throw new FederationInboundError(
      'forbidden',
      `actor ${remoteUser.remoteUserId} is not the author of message ${payload.messageId}`,
    );
  }

  // Soft-delete + cleanup, identical to the local DELETE handler:
  //   - tombstone the row (deletedAt + empty content)
  //   - drop reactions, mentions, pins — soft-delete does NOT cascade
  // All four writes participate in the inbound transaction; a failure on
  // any of them rolls back the envelope-log insert too.
  const deletedAt = new Date(payload.deletedAt);
  await tx.message.update({
    where: { id: existing.id },
    data: { deletedAt, content: '' },
  });
  await tx.messageReaction.deleteMany({ where: { messageId: existing.id } });
  await tx.userMention.deleteMany({ where: { messageId: existing.id } });
  await tx.pinnedMessage.deleteMany({ where: { messageId: existing.id } });

  const channelId = existing.channelId;
  const serverId = existing.serverId;

  return {
    result: { status: 200, body: { ok: true, data: { id: existing.id } } },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'MESSAGE_DELETE',
        serverId: serverId ?? undefined,
        channelId,
        data: { id: existing.id, channelId, deletedAt: deletedAt.toISOString() },
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

// --- reaction.add / reaction.remove handlers --------------------------------

/**
 * Common front-end work for inbound reactions: look up the target message,
 * verify it lives in a federation-enabled channel, confirm the actor is a
 * member of the channel's server, and reject custom-emoji references.
 *
 * Custom emojis don't cross federation in Phase 3. A `custom:<id>` payload
 * would reference a CustomEmoji row that exists only on the home instance,
 * which the receiver can't resolve. Cross-instance custom emoji is a Phase 4+
 * problem — see `docs/federation-followups.md`. Unicode reactions only.
 */
async function validateInboundReaction(input: {
  messageId: string;
  emoji: string;
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<{
  messageRow: {
    id: string;
    serverId: string | null;
    channelId: string;
  };
  localUserId: string;
}> {
  const { messageId, emoji, remoteUser, tx } = input;

  // reactionAddPayloadSchema validates emoji as a free-form string (z.string()),
  // so an attacker could send 'CUSTOM:abc' to slip past a case-sensitive check.
  // Defence-in-depth: lowercase before comparing.
  if (emoji.toLowerCase().startsWith('custom:')) {
    // Custom emojis are server-scoped and the id only resolves on the home
    // instance. Reject loudly so peers know to stick to unicode for now.
    throw new FederationInboundError(
      'forbidden',
      'custom emojis do not cross federation yet (unicode only)',
    );
  }

  const existing = await tx.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      serverId: true,
      channelId: true,
      deletedAt: true,
      channel: {
        select: {
          federationMode: true,
          server: { select: { federationEnabled: true } },
        },
      },
    },
  });
  if (!existing || existing.deletedAt) {
    // Soft-deleted messages are tombstones — reacting to them makes no sense,
    // same as the local PUT/DELETE route's `!message.deletedAt` gate.
    throw new FederationInboundError(
      'unknown_message',
      `message ${messageId} not found on this instance`,
    );
  }
  if (!existing.channelId) {
    // Defence in depth — federation reactions only flow through server
    // channels in Phase 3. A federated reaction targeting a DM would be a
    // protocol violation by the peer.
    throw new FederationInboundError(
      'unknown_message',
      `message ${messageId} is not in a server channel`,
    );
  }

  // Effective federation check — mirrors the outbound gate so a peer can't
  // sneak content into a channel that has federation force_off (or whose
  // server has federationEnabled=false + mode=inherit).
  const effective = computeEffectiveFederation(
    existing.channel?.server?.federationEnabled ?? false,
    (existing.channel?.federationMode ?? 'inherit') as FederationMode,
  );
  if (!effective) {
    throw new FederationInboundError(
      'federation_off',
      `federation is disabled for channel ${existing.channelId}`,
    );
  }

  // The actor (the reactor) MUST already be a member of the channel's server.
  // The outbound side only fans out to peers that have a member in the server;
  // the inbound side enforces the symmetric invariant — "we don't accept
  // reactions from a remote user we haven't already invited into this room."
  //
  // `ensureUserForRemoteUser` is typed as `PrismaClient`, but Prisma's
  // runtime accepts a TransactionClient anywhere a Client is expected; cast
  // through unknown so the call participates in this transaction.
  const localUser = await ensureUserForRemoteUser(
    remoteUser,
    tx as unknown as PrismaClient,
  );
  if (!existing.serverId) {
    // Shouldn't be reachable because we already required channelId above,
    // and server channels carry a serverId — but be explicit.
    throw new FederationInboundError(
      'unknown_message',
      `message ${messageId} has no server`,
    );
  }
  const member = await tx.serverMember.findUnique({
    where: { serverId_userId: { serverId: existing.serverId, userId: localUser.id } },
    select: { userId: true },
  });
  if (!member) {
    throw new FederationInboundError(
      'not_a_member',
      `actor ${remoteUser.remoteUserId} is not a member of server ${existing.serverId}`,
    );
  }

  return {
    messageRow: {
      id: existing.id,
      serverId: existing.serverId,
      channelId: existing.channelId,
    },
    localUserId: localUser.id,
  };
}

async function handleReactionAdd(input: {
  envelope: TwoLayerSignedEnvelope<ReactionAddPayload>;
  payload: ReactionAddPayload;
  peer: { id: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  const { messageRow, localUserId } = await validateInboundReaction({
    messageId: payload.messageId,
    emoji: payload.emoji,
    remoteUser,
    tx,
  });

  // Idempotent upsert — same shape as the local PUT route. A duplicate
  // reaction (same messageId+userId+emoji) is a no-op, not an error. The
  // unique composite key on MessageReaction handles the race naturally.
  await tx.messageReaction.upsert({
    where: {
      messageId_userId_emoji: {
        messageId: messageRow.id,
        userId: localUserId,
        emoji: payload.emoji,
      },
    },
    create: {
      messageId: messageRow.id,
      userId: localUserId,
      emoji: payload.emoji,
    },
    update: {},
  });

  const serverId = messageRow.serverId;
  const channelId = messageRow.channelId;

  return {
    result: { status: 200, body: { ok: true, data: { messageId: messageRow.id } } },
    postCommit: async (prisma) => {
      // Broadcast with the actor's LOCAL User id — that's the id local
      // clients already see attached to MessageReaction rows for this user.
      gatewayBroker.publish({
        type: 'REACTION_ADD',
        serverId: serverId ?? undefined,
        channelId,
        data: {
          messageId: messageRow.id,
          userId: localUserId,
          emoji: payload.emoji,
        },
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

async function handleReactionRemove(input: {
  envelope: TwoLayerSignedEnvelope<ReactionRemovePayload>;
  payload: ReactionRemovePayload;
  peer: { id: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  const { messageRow, localUserId } = await validateInboundReaction({
    messageId: payload.messageId,
    emoji: payload.emoji,
    remoteUser,
    tx,
  });

  // Idempotent delete — same shape as the local DELETE route. A missing row
  // is swallowed; the broadcast still fires so any client that has the
  // (already-removed) reaction in local cache catches up.
  try {
    await tx.messageReaction.delete({
      where: {
        messageId_userId_emoji: {
          messageId: messageRow.id,
          userId: localUserId,
          emoji: payload.emoji,
        },
      },
    });
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      // P2025 = "Record to delete does not exist". Idempotent — matches the
      // local DELETE handler's blanket try/catch.
    } else {
      throw err;
    }
  }

  const serverId = messageRow.serverId;
  const channelId = messageRow.channelId;

  return {
    result: { status: 200, body: { ok: true, data: { messageId: messageRow.id } } },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'REACTION_REMOVE',
        serverId: serverId ?? undefined,
        channelId,
        data: {
          messageId: messageRow.id,
          userId: localUserId,
          emoji: payload.emoji,
        },
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

// --- member.join_request handler --------------------------------------------

/**
 * Inbound `member.join_request` (P4-7).
 *
 * The peer (B) is asking us (A, the home of a federated invite) to redeem
 * a code. The envelope's two-layer signature has already proved (a) the
 * peer's instance signature checks out and (b) the joiner's user
 * signature over the payload checks out — so we know who is asking and
 * from which instance.
 *
 * Flow:
 *   1. Look up the invite. Must exist, must be federated, must point at
 *      a real Server.
 *   2. Apply validity gates (revoked / expired / exhausted) → 410.
 *   3. Apply scope gates:
 *        - any_peer        → no extra check (peer is peered already)
 *        - specific_instance → invite.remoteInstanceHost === peer.host
 *        - specific_user   → invite.remoteUserId === joinerRemoteUserId
 *      Anything mismatched → 403.
 *   4. Materialise the joiner as a local synthetic User via
 *      `ensureUserForRemoteUser`. The user-layer signature already
 *      established their public key, so we use the RemoteUser row
 *      resolved upstream.
 *   5. Attempt `ServerMember.create` and catch P2002 — this is the
 *      idempotency boundary. If the joiner is already a member, we
 *      skip the `invite.uses` increment.
 *   6. If the member was newly created, atomically increment
 *      `invite.uses` (conditional updateMany so a concurrent join can't
 *      push us past maxUses).
 *   7. Build the snapshot — Server + federation-enabled text/forum
 *      Channels + all current ServerMembers.
 *   8. Return `responseEnvelopePayload` so the dispatcher wraps the
 *      snapshot in a signed `member.joined` envelope, broadcast
 *      `MEMBER_ADD` post-commit, and (P4-10) fan out `member.add` to
 *      OTHER peers in T (every peered instance besides the joiner's
 *      home). The exclusion is `excludePeerInstanceId: peer.id` because
 *      the joiner's home already knows the join succeeded — it sent us
 *      the request and receives the snapshot in the signed `member.joined`
 *      response.
 */
async function handleMemberJoinRequest(input: {
  envelope: TwoLayerSignedEnvelope<MemberJoinRequestPayload>;
  payload: MemberJoinRequestPayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
  selfHost: string | null;
  queues: QueueClient | null;
  federationEnabledOnInstance: boolean;
  log: FastifyBaseLogger;
}): Promise<HandlerOutput> {
  const { envelope, payload, peer, remoteUser, tx, selfHost, queues, federationEnabledOnInstance, log } = input;

  if (!selfHost) {
    // Configuration bug — see `processEnvelope` for the matching check.
    // Raised here so the join handler can't be invoked on a service that
    // doesn't know its own host (the snapshot uses selfHost for local
    // members' qualified ids).
    throw new Error(
      'member.join_request requires selfHost on FederationInboundService',
    );
  }

  // Defence-in-depth: the user-layer signature verified that the payload
  // was signed by `remoteUser.publicKey`. Make sure the joiner field in
  // the payload matches the verified RemoteUser, so a malicious peer
  // can't sign with user A's key and pretend the joiner is user B. The
  // signing flow on the sending side puts the same id in both places;
  // they should never diverge in practice.
  if (payload.joinerRemoteUserId !== remoteUser.remoteUserId) {
    throw new FederationInboundError(
      'bad_envelope',
      `joinerRemoteUserId ${payload.joinerRemoteUserId} does not match ` +
        `verified user ${remoteUser.remoteUserId}`,
    );
  }

  // Step 1 — look up the invite. Includes everything needed to validate
  // scope + build the snapshot in one round-trip.
  const invite = await tx.invite.findUnique({
    where: { code: payload.inviteCode },
    select: {
      id: true,
      code: true,
      scope: true,
      serverId: true,
      maxUses: true,
      uses: true,
      expiresAt: true,
      revokedAt: true,
      remoteScope: true,
      remoteInstanceHost: true,
      remoteUserId: true,
    },
  });

  if (!invite) {
    throw new FederationInboundError(
      'unknown_invite',
      `invite ${payload.inviteCode} not found`,
    );
  }
  // Local-only invites are indistinguishable from non-existent ones —
  // matches the invite-preview surface so a malicious peer can't probe
  // local invite codes by trying to redeem them. Same error message as
  // the missing-invite branch above so a peer can't distinguish the two.
  if (invite.remoteScope === null) {
    throw new FederationInboundError(
      'unknown_invite',
      `invite ${payload.inviteCode} not found`,
    );
  }
  if (invite.scope !== 'server' || !invite.serverId) {
    // Federation Phase 4 only supports server-scoped invites. Channel-
    // scoped federated invites are not implemented; treat as unknown
    // rather than a 4xx that leaks invite-existence.
    throw new FederationInboundError(
      'unknown_invite',
      `invite ${payload.inviteCode} is not server-scoped`,
    );
  }

  // Step 2 — validity gates. Order matches the preview route's wording
  // for consistency, but the wire status is the same (410) for all three.
  if (invite.revokedAt) {
    throw new FederationInboundError(
      'invite_no_longer_valid',
      'invite has been revoked',
    );
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new FederationInboundError(
      'invite_no_longer_valid',
      'invite has expired',
    );
  }
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
    throw new FederationInboundError(
      'invite_no_longer_valid',
      'invite has been fully used',
    );
  }

  // Step 3 — scope check. `any_peer` requires no extra check (the peer is
  // already verified as peered before dispatch). Specific scopes pin the
  // invite to a host or qualified user id; mismatch → 403.
  if (invite.remoteScope === 'specific_instance') {
    if (invite.remoteInstanceHost !== peer.host) {
      throw new FederationInboundError(
        'forbidden',
        `invite is scoped to ${invite.remoteInstanceHost ?? '<unset>'}, not ${peer.host}`,
      );
    }
  } else if (invite.remoteScope === 'specific_user') {
    // specific_user pins both the host AND the user id. The host check
    // mirrors specific_instance — even though the user id contains the
    // host, an inconsistent pair is still a protocol violation.
    if (
      invite.remoteInstanceHost !== peer.host ||
      invite.remoteUserId !== payload.joinerRemoteUserId
    ) {
      throw new FederationInboundError(
        'forbidden',
        `invite is scoped to a different user`,
      );
    }
  }

  // Step 4 — materialise the joiner as a local synthetic User. The
  // `ensureUserForRemoteUser` helper is keyed on RemoteUser.remoteUserId,
  // which is unique; it is idempotent across concurrent calls.
  const localJoiner = await ensureUserForRemoteUser(
    remoteUser,
    tx as unknown as PrismaClient,
  );

  // Step 5 — try to create the ServerMember. P2002 on the composite PK
  // (serverId, userId) means the joiner is already a member; treat that
  // as an idempotent success and skip the uses increment.
  let newMember = true;
  // The ServerMember.joinedAt is sourced from the Prisma row default and
  // captured here so the `member.add` fan-out (post-commit) sends the
  // canonical timestamp on the wire — not "whenever the post-commit hook
  // happened to run", which could be milliseconds later.
  let memberJoinedAt: Date | null = null;
  try {
    const created = await tx.serverMember.create({
      data: { serverId: invite.serverId, userId: localJoiner.id },
    });
    memberJoinedAt = created.joinedAt;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      newMember = false;
    } else {
      throw err;
    }
  }

  // Step 6 — atomic uses increment, only when we actually added a row.
  // The conditional updateMany mirrors the auth-service register() flow:
  // if a concurrent join already consumed the last use, our updateMany's
  // WHERE clause no longer matches and result.count comes back 0. We
  // treat that as "invite was exhausted under us" and surface 410. This
  // can technically race against the maxUses check above; serializing
  // the read+write across two queries is the only way to ensure a
  // strictly-bounded count.
  if (newMember) {
    const result = await tx.invite.updateMany({
      where: {
        id: invite.id,
        revokedAt: null,
        ...(invite.maxUses !== null
          ? { uses: { lt: invite.maxUses } }
          : {}),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { uses: { increment: 1 } },
    });
    if (result.count === 0) {
      // Race lost — another joiner consumed the final use between our
      // initial validity check and now. Rolling back the transaction
      // means we ALSO drop the ServerMember we just inserted, which is
      // the correct outcome (the invite is no longer valid).
      throw new FederationInboundError(
        'invite_no_longer_valid',
        'invite has been fully used',
      );
    }
  }

  // Step 7 — build the snapshot. The roster includes the joiner (the
  // ServerMember we just inserted is committed to `tx`) and every other
  // current ServerMember.
  const snapshot = await buildServerSnapshot({
    tx,
    serverId: invite.serverId,
    selfHost,
  });

  // Step 8 — return. The dispatcher will wrap `responseEnvelopePayload`
  // in a single-layer signed envelope; post-commit fires the MEMBER_ADD
  // gateway broadcast + lastSeenAt touch.
  const memberJoinedPayload: MemberJoinedPayload = {
    inviteCode: payload.inviteCode,
    serverSnapshot: snapshot,
  };
  // Defence-in-depth: validate our own outgoing payload before signing
  // it. Catches drift between this code and the wire schema at the
  // sending side rather than at every peer.
  memberJoinedPayloadSchema.parse(memberJoinedPayload);

  const serverIdForBroadcast = invite.serverId;
  const localJoinerId = localJoiner.id;
  // envelope.eventType is used in the log line for consistency; the
  // postCommit closure captures the few primitives it needs.
  void envelope;

  // Pre-fetch the home server's federation state so the post-commit
  // fan-out hook can decide whether to fire. We're inside the
  // transaction here — reading via `tx` so a concurrent flip of
  // federationEnabled doesn't sneak past our gate. The values are
  // captured into the closure below.
  const serverForFanOut = await tx.server.findUnique({
    where: { id: invite.serverId },
    select: { federationEnabled: true, originInstanceId: true },
  });

  return {
    result: { status: 200 },
    responseEnvelopePayload: {
      eventType: 'member.joined',
      payload: memberJoinedPayload,
    },
    postCommit: async (prisma) => {
      // Broadcast locally so any client currently viewing the home
      // server gets the new member without a roster refetch. Skipped on
      // the idempotent path (member was already present) — there's no
      // new state to announce.
      if (newMember) {
        gatewayBroker.publish({
          type: 'MEMBER_ADD',
          serverId: serverIdForBroadcast,
          data: { serverId: serverIdForBroadcast, userId: localJoinerId },
        });
      }

      // P4-10 — fan out `member.add` to OTHER peers of T. Gated on:
      //   1. We actually inserted a row (idempotent re-accept → no fan-out).
      //   2. `queues` is wired (FEDERATION_ENABLED at the instance level).
      //   3. `selfHost` is known (handler asserted this at entry).
      //   4. Server is federated AND we own it (originInstanceId is null —
      //      the inbound dispatcher only ever lands on the home of T, so
      //      this should always be true; defence in depth).
      //   5. We captured a `joinedAt` from the insert (always true on the
      //      newMember branch, but the type-narrowing is explicit so a
      //      future refactor can't accidentally skip it).
      //
      // `excludePeerInstanceId: peer.id` is the load-bearing parameter:
      // the joiner's home (the peer that just sent us this request) is
      // already authoritatively aware of the new member — that's where
      // the request originated — and would receive the snapshot in the
      // signed `member.joined` response a few lines above. Fanning back
      // to them would be a duplicate (at best) and audit-noise (at
      // worst).
      if (
        newMember &&
        queues &&
        selfHost &&
        memberJoinedAt &&
        serverForFanOut?.federationEnabled &&
        serverForFanOut.originInstanceId === null
      ) {
        try {
          await fanOutMemberAdd({
            queues,
            selfHost,
            serverId: serverIdForBroadcast,
            memberRemoteUserId: remoteUser.remoteUserId,
            memberDisplayName: remoteUser.displayNameCache,
            joinedAt: memberJoinedAt,
            // The signing user is the joiner themselves — same identity
            // we just verified at the user-signature layer above. Their
            // synthetic local User row is `localJoiner.id`; the matching
            // user-key is provisioned alongside it by
            // `ensureUserForRemoteUser`.
            authorUserId: localJoinerId,
            log,
            excludePeerInstanceId: peer.id,
            federationEnabledOnInstance,
          });
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          log.warn(
            { err: errObj, serverId: serverIdForBroadcast, userId: localJoinerId },
            'federation fan-out failed for member.add (inbound member.join_request)',
          );
        }
      }

      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

// --- mirror lifecycle handlers (P4-8) ---------------------------------------

/**
 * Shared author resolver for the four mirror-lifecycle envelopes
 * (server.update + channel.create/update/delete). Used as the handler's
 * `resolveAuthorRemoteUserId` callback — runs BEFORE crypto.
 *
 * Responsibilities, in order:
 *   1. Pull the target server id from the payload (the key differs only
 *      structurally; the field is named `serverId` on every mirror payload).
 *   2. Look up the mirror Server row and verify it actually IS a mirror
 *      (`originInstanceId != null`) → otherwise 404 `unknown_mirror_server`.
 *      A LOCAL server matching the id is treated the same as a missing one:
 *      we never mutate a local server in response to a peer envelope.
 *   3. Verify the peer that sent the envelope is the mirror's origin
 *      (`originInstanceId === peer.id`) → otherwise 403 `not_origin`. This
 *      is the core security check for these handlers: only the home peer
 *      can push mutations for a Server it owns.
 *   4. Resolve the mirror Server's owner User row and return their
 *      `remoteUserId` (the qualified `<localpart>@<peerHost>` id). The
 *      owner is by definition a synthetic mirror user — `User.remoteUserId`
 *      is populated — so this lookup is just a field read.
 *
 * Throwing `FederationInboundError` here is the canonical place to surface
 * the early-fail conditions: the dispatcher catches them and routes to the
 * appropriate HTTP status without performing any signature verification.
 */
async function resolveMirrorOwner(
  input: {
    payload: unknown;
    peer: { id: string; host: string };
    prisma: PrismaClient;
  },
  serverIdField: 'serverId',
): Promise<string> {
  const v = (input.payload as Record<string, unknown> | null)?.[serverIdField];
  if (typeof v !== 'string' || v.length === 0) {
    throw new FederationInboundError(
      'bad_envelope',
      'payload missing serverId',
    );
  }
  const serverId = v;

  const server = await input.prisma.server.findUnique({
    where: { id: serverId },
    select: {
      id: true,
      originInstanceId: true,
      ownerUserId: true,
    },
  });
  // Local servers and missing rows produce the same code on purpose — a
  // peer cannot probe for the existence of a local server by trying to
  // mutate it as if it were a mirror.
  if (!server || server.originInstanceId === null) {
    throw new FederationInboundError(
      'unknown_mirror_server',
      `mirror server ${serverId} not found on this instance`,
    );
  }
  if (server.originInstanceId !== input.peer.id) {
    throw new FederationInboundError(
      'not_origin',
      `peer ${input.peer.host} is not the origin of mirror server ${serverId}`,
    );
  }

  const owner = await input.prisma.user.findUnique({
    where: { id: server.ownerUserId },
    select: { remoteUserId: true },
  });
  if (!owner?.remoteUserId) {
    // Invariant: a mirror Server's owner row is always a synthetic remote
    // user with `remoteUserId` populated. If we got here, the mirror was
    // created via a non-standard path — surface as bad_envelope so the
    // peer (eventually) sees a 4xx rather than a 500.
    throw new FederationInboundError(
      'bad_envelope',
      `mirror server ${serverId} owner has no remoteUserId`,
    );
  }
  return owner.remoteUserId;
}

/**
 * Build a `FederationMirrorService` bound to this handler's transaction.
 * The mirror service's `resolveRemoteUser` callback is set to a throwing
 * stub because the four P4-8 envelopes never call into the create-server
 * / add-member paths — those are the only ones that need a real resolver.
 * Defence-in-depth: if a future handler accidentally calls
 * `createMirrorServer`/`addMirrorMember` from this code path, the stub
 * raises loudly instead of hitting the network.
 */
function makeMirrorServiceForLifecycle(): FederationMirrorService {
  return new FederationMirrorService({
    resolveRemoteUser: () => {
      throw new Error(
        'mirror-lifecycle handlers must not resolve RemoteUser rows',
      );
    },
  });
}

async function handleServerUpdate(input: {
  envelope: TwoLayerSignedEnvelope<ServerUpdatePayload>;
  payload: ServerUpdatePayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  // `resolveMirrorOwner` already verified mirror existence + sender + owner;
  // this handler only mutates the surface fields and broadcasts.
  const mirror = makeMirrorServiceForLifecycle();
  await mirror.updateMirrorServer(tx, {
    serverId: payload.serverId,
    name: payload.name,
    description: payload.description,
    iconUrl: payload.iconUrl,
  });

  // Reload the row in the shape `serializeServer` expects. The mirror
  // helper is keyed on update fields only, so we always re-read post-mutate.
  // P4-16 — also pull `originInstanceId` + `originInstance.host` so the
  // SERVER_UPDATE broadcast carries the federated-den badge fields.
  const updated = await tx.server.findUniqueOrThrow({
    where: { id: payload.serverId },
    select: {
      id: true,
      ownerUserId: true,
      name: true,
      description: true,
      iconAttachmentId: true,
      defaultRoleId: true,
      federationEnabled: true,
      originInstanceId: true,
      originInstance: { select: { host: true } },
      createdAt: true,
    },
  });
  const dto = serializeServer(updated);

  return {
    result: { status: 200, body: { ok: true, data: { id: updated.id } } },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'SERVER_UPDATE',
        serverId: updated.id,
        data: dto,
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

async function handleChannelCreate(input: {
  envelope: TwoLayerSignedEnvelope<ChannelCreatePayload>;
  payload: ChannelCreatePayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, peer, remoteUser, tx } = input;

  const mirror = makeMirrorServiceForLifecycle();
  await mirror.upsertMirrorChannel({
    tx,
    serverId: payload.serverId,
    originInstanceId: peer.id,
    channelId: payload.channel.id,
    name: payload.channel.name,
    type: payload.channel.type,
    topic: payload.channel.topic,
    position: payload.channel.position,
    // The wire schema has `.default('inherit')` / `.default(false)` on these
    // two fields; Zod inference still surfaces them as optional, so coalesce
    // for the mirror helper which wants concrete values.
    federationMode: payload.channel.federationMode ?? 'inherit',
    nsfw: payload.channel.nsfw ?? false,
  });

  const row = await tx.channel.findUniqueOrThrow({
    where: { id: payload.channel.id },
    select: {
      id: true,
      serverId: true,
      parentId: true,
      campaignId: true,
      gameNightId: true,
      type: true,
      name: true,
      topic: true,
      position: true,
      nsfw: true,
      videoEnabled: true,
      federationMode: true,
      createdAt: true,
    },
  });
  const dto = serializeChannel(row);

  return {
    result: { status: 200, body: { ok: true, data: { id: row.id } } },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'CHANNEL_CREATE',
        serverId: row.serverId,
        channelId: row.id,
        data: dto,
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

async function handleChannelUpdate(input: {
  envelope: TwoLayerSignedEnvelope<ChannelUpdatePayload>;
  payload: ChannelUpdatePayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  // Confirm the channel is in fact on the mirror Server we already
  // validated. `upsertMirrorChannel` requires the full shape (type, etc.),
  // so for an UPDATE we read the existing row first and merge.
  const existing = await tx.channel.findUnique({
    where: { id: payload.channelId },
    select: {
      id: true,
      serverId: true,
      type: true,
      name: true,
      topic: true,
      position: true,
      federationMode: true,
      nsfw: true,
    },
  });
  if (!existing || existing.serverId !== payload.serverId) {
    // Same shape as the message handlers' `unknown_message` guard: the
    // channel either doesn't exist locally or has been moved to a
    // different server. The latter shouldn't happen for federated
    // channels but is a cheap defence against a buggy peer.
    throw new FederationInboundError(
      'unknown_channel',
      `channel ${payload.channelId} not found on server ${payload.serverId}`,
    );
  }
  if (existing.type !== 'text' && existing.type !== 'forum') {
    // Mirror channels must be text/forum (createMirrorServer enforces it).
    // If we ever hit this it's a data-integrity issue, not a peer bug.
    throw new FederationInboundError(
      'unknown_channel',
      `channel ${payload.channelId} is not a mirror-supported type`,
    );
  }

  const mirror = makeMirrorServiceForLifecycle();
  await mirror.upsertMirrorChannel({
    tx,
    serverId: payload.serverId,
    // originInstanceId is intentionally NOT changed by upsertMirrorChannel
    // (see the helper's `update:` clause). We pass the existing id through
    // for the create branch's invariant — it shouldn't be reached for an
    // UPDATE because we already proved the row exists.
    originInstanceId: input.peer.id,
    channelId: payload.channelId,
    // Coalesce against existing row values for fields the wire schema
    // marks optional. Each undefined field is preserved.
    name: payload.name ?? existing.name,
    type: existing.type as 'text' | 'forum',
    topic: payload.topic !== undefined ? payload.topic : existing.topic,
    position: payload.position ?? existing.position,
    federationMode:
      payload.federationMode ??
      (existing.federationMode as 'inherit' | 'force_on' | 'force_off'),
    nsfw: payload.nsfw ?? existing.nsfw,
  });

  const updated = await tx.channel.findUniqueOrThrow({
    where: { id: payload.channelId },
    select: {
      id: true,
      serverId: true,
      parentId: true,
      campaignId: true,
      gameNightId: true,
      type: true,
      name: true,
      topic: true,
      position: true,
      nsfw: true,
      videoEnabled: true,
      federationMode: true,
      createdAt: true,
    },
  });
  const dto = serializeChannel(updated);

  return {
    result: { status: 200, body: { ok: true, data: { id: updated.id } } },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'CHANNEL_UPDATE',
        serverId: updated.serverId,
        channelId: updated.id,
        data: dto,
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

async function handleChannelDelete(input: {
  envelope: TwoLayerSignedEnvelope<ChannelDeletePayload>;
  payload: ChannelDeletePayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  // The mirror helper is idempotent (no-op when the channel is already
  // gone). It also enforces `channel.serverId === payload.serverId` and
  // throws otherwise — that's stricter than `deleteMirrorChannel`'s
  // own comment but matches the guard already there.
  const mirror = makeMirrorServiceForLifecycle();
  await mirror.deleteMirrorChannel(tx, payload.serverId, payload.channelId);

  // Critically: do NOT tear down the mirror Server here even if this was
  // the last channel. The mirror can survive with zero channels — the
  // Server row, owner User, and any ServerMember rows remain so that a
  // subsequent `channel.create` from the same home repopulates an
  // already-discoverable mirror. Teardown happens only when the LOCAL
  // member list empties out (see `tearDownMirrorServerIfEmpty`).

  return {
    result: {
      status: 200,
      body: { ok: true, data: { id: payload.channelId } },
    },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'CHANNEL_DELETE',
        serverId: payload.serverId,
        channelId: payload.channelId,
        data: { id: payload.channelId },
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

// --- mirror membership handlers (P4-11) -------------------------------------

/**
 * Inbound `member.add` (P4-11).
 *
 * Peer A — the origin of a mirror Server T held on this instance — is
 * telling us a new member has joined T. The envelope's `resolveMirrorOwner`
 * resolver already verified:
 *   - the target mirror exists (`unknown_mirror_server` otherwise),
 *   - the sending peer is the mirror's origin (`not_origin` otherwise),
 *   - and the user-layer signer is the mirror Server's owner on A.
 *
 * The handler itself:
 *   1. Materialises the new member's RemoteUser via the production
 *      profile-backed resolver (cache hit returns the existing row;
 *      cache miss does a `fetchRemoteProfile` + upsert).
 *   2. Calls `addMirrorMember`, which synthesises a local User row if
 *      needed and inserts a `ServerMember`. Idempotent — a duplicate
 *      envelope hits the P2002 short-circuit inside the mirror helper
 *      and returns the existing local user id.
 *   3. Post-commit broadcasts `MEMBER_ADD` to any local clients viewing
 *      the mirror, and touches `RemoteUser.lastSeenAt` for the envelope
 *      author (the mirror owner — the one who signed the announcement).
 *
 * Critically: we do NOT fan out `member.add` to other peers from here.
 * Mirrors never originate membership envelopes — the home is the only
 * authority and has already done its own fan-out to every peer of T.
 */
async function handleMemberAdd(input: {
  envelope: TwoLayerSignedEnvelope<MemberAddPayload>;
  payload: MemberAddPayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
  profile: FederationProfileService;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx, profile } = input;

  // Build a production mirror service for this handler — `addMirrorMember`
  // genuinely needs to resolve the joiner's RemoteUser (cache hit or
  // profile fetch). The throwing stub used by the other lifecycle
  // handlers wouldn't work here.
  const mirror = new FederationMirrorService({
    resolveRemoteUser: makeProfileBackedRemoteUserResolver(profile),
  });
  const localUserId = await mirror.addMirrorMember(
    tx,
    payload.serverId,
    payload.memberRemoteUserId,
    payload.memberDisplayName,
  );

  return {
    result: {
      status: 200,
      body: { ok: true, data: { serverId: payload.serverId, userId: localUserId } },
    },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'MEMBER_ADD',
        serverId: payload.serverId,
        data: { serverId: payload.serverId, userId: localUserId },
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

/**
 * Inbound `member.remove` (P4-11).
 *
 * Peer A is telling us a member has left T (kicked / banned / left). The
 * `resolveMirrorOwner` resolver verified mirror existence + origin + signer
 * identity. The handler:
 *   1. Resolves the local mirror User id BEFORE deletion so the gateway
 *      broadcast can name them — `removeMirrorMember` itself doesn't
 *      return the id, and post-deletion the row is gone.
 *   2. Calls `removeMirrorMember` (idempotent — no-op on missing row).
 *   3. Post-commit broadcasts `MEMBER_REMOVE` to local viewers and
 *      touches `RemoteUser.lastSeenAt` for the envelope author.
 *
 * Critically: we do NOT call `tearDownMirrorServerIfEmpty` here. This
 * envelope only removes ONE member; teardown is gated on the LOCAL user
 * leaving the mirror themselves (the P4-12 voluntary-leave flow). Even
 * if the removed member was the last remote-mirror user, the local user
 * who originally accepted the federated invite is still a member and the
 * mirror must stay reachable for them.
 *
 * The post-broadcast id is the local synthetic User row (or `null` if no
 * such row exists — the member was already gone before the envelope
 * arrived, e.g. concurrent removal). The broadcast still fires with a
 * `null` userId in that case so any optimistic UI state on the client
 * settles; downstream selectors are tolerant of unknown ids.
 */
async function handleMemberRemove(input: {
  envelope: TwoLayerSignedEnvelope<MemberRemovePayload>;
  payload: MemberRemovePayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
}): Promise<HandlerOutput> {
  const { payload, remoteUser, tx } = input;

  // Look up the local user id BEFORE we delete the ServerMember row —
  // `removeMirrorMember` doesn't return it, and after the delete the
  // synthetic User row is still there (we keep mirror Users around for
  // idempotency) but we need the id at broadcast time. Use the qualified
  // `User.remoteUserId` index which `addMirrorMember` populates.
  const localUser = await tx.user.findUnique({
    where: { remoteUserId: payload.memberRemoteUserId },
    select: { id: true },
  });
  const localUserId = localUser?.id ?? null;

  // Reuse the throwing-stub mirror service — `removeMirrorMember` does
  // NOT call `resolveRemoteUser` (it looks up the local user via
  // `User.remoteUserId` directly), so the stub is fine here. Matches the
  // P4-8 lifecycle handlers.
  const mirror = makeMirrorServiceForLifecycle();
  await mirror.removeMirrorMember(tx, payload.serverId, payload.memberRemoteUserId);

  return {
    result: {
      status: 200,
      body: { ok: true, data: { serverId: payload.serverId, userId: localUserId } },
    },
    postCommit: async (prisma) => {
      gatewayBroker.publish({
        type: 'MEMBER_REMOVE',
        serverId: payload.serverId,
        data: { serverId: payload.serverId, userId: localUserId },
      });
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });
    },
  };
}

/**
 * Inbound `member.leave` (P4-12).
 *
 * Peer B is telling us — A, the HOME of T — that one of B's users is
 * voluntarily leaving the Tavern. Distinct from `member.remove` in three ways:
 *
 *   1. The user-layer signer is the leaver themselves, not the mirror owner.
 *      Only the user can request their own leave; we reject envelopes where
 *      the verified `remoteUser` doesn't match the payload's
 *      `leaverRemoteUserId` with `unauthorized_leave` (401).
 *   2. T is owned LOCALLY here (originInstanceId is null). The dispatcher's
 *      generic peer + signature checks still apply, but the mirror-owner
 *      resolver doesn't, so `extractAuthorRemoteUserId` returns the
 *      `leaverRemoteUserId` directly.
 *   3. The handler returns a single-layer signed `member.removed` ack
 *      envelope (mirroring the request/response pattern P4-7 introduced for
 *      `member.join_request`). B uses the ack to commit the local
 *      ServerMember removal + optional mirror tear-down — see the matching
 *      route in `routes/federation-leave-mirror.ts`.
 *
 * The handler is idempotent — if the ServerMember is already gone (or the
 * local User row doesn't exist), we still return a signed
 * `member.removed` ack so a retried envelope settles cleanly on B. The
 * authorization check still runs first, so a peer can't probe by
 * impersonating an unrelated user.
 */
async function handleMemberLeave(input: {
  envelope: TwoLayerSignedEnvelope<MemberLeavePayload>;
  payload: MemberLeavePayload;
  peer: { id: string; host: string };
  remoteUser: NonNullable<
    Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
  >;
  tx: Prisma.TransactionClient;
  selfHost: string | null;
  queues: QueueClient | null;
  federationEnabledOnInstance: boolean;
  log: FastifyBaseLogger;
}): Promise<HandlerOutput> {
  const {
    payload,
    peer,
    remoteUser,
    tx,
    queues,
    federationEnabledOnInstance,
    log,
  } = input;

  // 1) Authorization: the user-layer signature was verified against
  //    `remoteUser.publicKey`; cross-check that the verified `remoteUser`
  //    matches the leaver in the payload. The dispatcher's
  //    `extractAuthorRemoteUserId` already pulls from
  //    `payload.leaverRemoteUserId`, so the two SHOULD match unless a peer
  //    forged a payload that names a different user than the one whose key
  //    they used to sign. Belt-and-suspenders defence: reject explicitly so
  //    the audit trail captures the attempt.
  if (payload.leaverRemoteUserId !== remoteUser.remoteUserId) {
    throw new FederationInboundError(
      'unauthorized_leave',
      `leaverRemoteUserId ${payload.leaverRemoteUserId} does not match ` +
        `verified user ${remoteUser.remoteUserId}`,
    );
  }

  // 2) Resolve the leaver's local synthetic User row. A leave for someone we
  //    never mirrored is a protocol bug — the user couldn't have joined us
  //    in the first place. 404 with `unknown_member` rather than the
  //    `unknown_mirror_server` shape since T is local (we own it), not a
  //    mirror.
  const localUser = await tx.user.findUnique({
    where: { remoteUserId: payload.leaverRemoteUserId },
    select: { id: true },
  });
  if (!localUser) {
    throw new FederationInboundError(
      'unknown_member',
      `no local User row for ${payload.leaverRemoteUserId}`,
    );
  }

  // 3) Look up the existing ServerMember. Missing → idempotent success: the
  //    user already left (or was never a member of T from our side). We
  //    still return the signed ack so the caller commits the no-op cleanly.
  const existingMember = await tx.serverMember.findUnique({
    where: {
      serverId_userId: { serverId: payload.serverId, userId: localUser.id },
    },
    select: { userId: true },
  });

  let memberWasPresent = false;
  // Capture the server's federation state up front so the post-commit
  // fan-out gate can use it. We're inside the transaction; the gate sees
  // the value at this exact moment, not whatever an operator flipped to
  // afterwards. For a local home of T, originInstanceId is null by
  // definition; defence in depth checks both.
  const serverForFanOut = await tx.server.findUnique({
    where: { id: payload.serverId },
    select: { federationEnabled: true, originInstanceId: true },
  });

  if (existingMember) {
    memberWasPresent = true;
    await tx.serverMember.delete({
      where: {
        serverId_userId: { serverId: payload.serverId, userId: localUser.id },
      },
    });
  }

  // 4) Build the `member.removed` ack payload. The dispatcher will wrap
  //    this in a single-layer signed envelope.
  const memberRemovedPayload: MemberRemovedPayload = {
    serverId: payload.serverId,
    leaverRemoteUserId: payload.leaverRemoteUserId,
  };

  const leaverRemoteUserId = payload.leaverRemoteUserId;
  const serverId = payload.serverId;
  const localUserId = localUser.id;
  const leaverHomePeerId = peer.id;

  return {
    result: { status: 200 },
    responseEnvelopePayload: {
      eventType: 'member.removed',
      payload: memberRemovedPayload,
    },
    postCommit: async (prisma) => {
      // Always touch lastSeenAt — we heard from this peer even on the
      // idempotent path.
      await prisma.remoteUser.update({
        where: { id: remoteUser.id },
        data: { lastSeenAt: new Date() },
      });

      // Local broadcast + fan-out only when we actually deleted a row.
      // Same gate as the inbound `member.join_request` post-commit: an
      // already-removed envelope is a no-op for downstream observers.
      if (!memberWasPresent) return;

      gatewayBroker.publish({
        type: 'MEMBER_REMOVE',
        serverId,
        data: { serverId, userId: localUserId },
      });

      // Fan-out `member.remove` (reason: 'left') to OTHER peers with
      // remaining members in T. The leaver's home (the peer that just
      // sent us this envelope) is excluded via `excludePeerInstanceId` —
      // they already know about the leave, since they're the source and
      // received the synchronous `member.removed` ack as the HTTP
      // response. Without the exclude, a home that still has OTHER
      // members in T would receive a duplicate envelope which, while
      // idempotent at `removeMirrorMember`, would generate audit-trail
      // noise.
      if (
        queues &&
        input.selfHost &&
        serverForFanOut?.federationEnabled &&
        serverForFanOut.originInstanceId === null
      ) {
        try {
          // The user-layer signer for the OUT-going envelope is the
          // leaver themselves — same identity we just verified the
          // INCOMING user signature against. Their synthetic local User
          // row is `localUserId`; the matching user-key is provisioned
          // alongside it by `ensureUserForRemoteUser`.
          await fanOutMemberRemove({
            queues,
            selfHost: input.selfHost,
            serverId,
            memberRemoteUserId: leaverRemoteUserId,
            reason: 'left',
            removedAt: new Date(),
            actorUserId: localUserId,
            log,
            excludePeerInstanceId: leaverHomePeerId,
            federationEnabledOnInstance,
          });
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          log.warn(
            { err: errObj, serverId, leaverRemoteUserId, leaverHomePeerId },
            'federation fan-out failed for member.remove (inbound member.leave)',
          );
        }
      }
    },
  };
}

/**
 * Build a `ServerSnapshot` payload from committed state inside a
 * transaction. Used by `handleMemberJoinRequest` and (later) any other
 * path that needs to bootstrap a peer with the current shape of T.
 *
 * The roster includes EVERY current ServerMember — local users carry a
 * qualified id `<localpart>@<selfHost>`; remote-mirror users carry
 * `User.remoteUserId` directly. Channels are filtered to text + forum
 * with effective federation ON.
 */
async function buildServerSnapshot(input: {
  tx: Prisma.TransactionClient;
  serverId: string;
  selfHost: string;
}): Promise<ServerSnapshot> {
  const { tx, serverId, selfHost } = input;

  const server = await tx.server.findUnique({
    where: { id: serverId },
    select: {
      id: true,
      ownerUserId: true,
      name: true,
      description: true,
      iconAttachmentId: true,
      federationEnabled: true,
      createdAt: true,
    },
  });
  if (!server) {
    // Invariant violation — the invite has serverId pointing at this row,
    // and Invite.serverId has a Cascade FK. If we got here, something
    // deleted the Server between the invite lookup and the snapshot
    // build (or the row's id never existed). Surface as a 500 by throwing
    // a plain Error so the route layer doesn't translate it as a
    // recoverable code.
    throw new Error(`server ${serverId} disappeared mid-transaction`);
  }
  if (!server.federationEnabled) {
    // Defence-in-depth: even if an invite was minted while federation was
    // on, the operator may have flipped it off afterwards. Reject the
    // join rather than expose a snapshot for a non-federated server.
    throw new FederationInboundError(
      'invite_no_longer_valid',
      `server ${serverId} has federation disabled`,
    );
  }

  // Owner identity — local users carry a qualified id built from their
  // username + selfHost. The owner is by definition LOCAL on the home
  // instance (you can't own a mirror you don't run); we still guard
  // against `null` username gracefully via findUniqueOrThrow.
  const owner = await tx.user.findUnique({
    where: { id: server.ownerUserId },
    select: { username: true, remoteUserId: true },
  });
  if (!owner) {
    throw new Error(`server ${serverId} owner ${server.ownerUserId} has no User row`);
  }
  // Mirror servers shouldn't be reachable here (the route is only on the
  // home), but the owner's qualified id falls through to their
  // remoteUserId if they happen to be a synthetic mirror user.
  const ownerRemoteUserId = owner.remoteUserId ?? `${owner.username}@${selfHost}`;

  // Channels — only text + forum, only with effective federation ON.
  // Voice / stage / category / campaign / session / board_game channels
  // are per-instance state and not part of the mirror surface.
  const channelRows = await tx.channel.findMany({
    where: {
      serverId,
      type: { in: ['text', 'forum'] },
    },
    select: {
      id: true,
      name: true,
      type: true,
      topic: true,
      position: true,
      federationMode: true,
      nsfw: true,
    },
    orderBy: { position: 'asc' },
  });
  const channels = channelRows
    .filter((c) => {
      const mode = (c.federationMode ?? 'inherit') as FederationMode;
      return computeEffectiveFederation(server.federationEnabled, mode);
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type as 'text' | 'forum',
      topic: c.topic,
      position: c.position,
      federationMode: (c.federationMode ?? 'inherit') as
        | 'inherit'
        | 'force_on'
        | 'force_off',
      nsfw: c.nsfw,
    }));

  // Member roster — local users carry `<localpart>@<selfHost>`; mirror
  // users carry `User.remoteUserId` directly. `displayName` falls back
  // to the user's username when unset.
  const memberRows = await tx.serverMember.findMany({
    where: { serverId },
    select: {
      joinedAt: true,
      user: {
        select: {
          username: true,
          displayName: true,
          remoteUserId: true,
        },
      },
    },
    orderBy: { joinedAt: 'asc' },
  });
  const members = memberRows.map((m) => ({
    remoteUserId: m.user.remoteUserId ?? `${m.user.username}@${selfHost}`,
    displayName: m.user.displayName,
    joinedAt: m.joinedAt.toISOString(),
  }));

  return {
    serverId: server.id,
    ownerRemoteUserId,
    name: server.name,
    description: server.description,
    iconUrl: deriveServerIconUrl(server.iconAttachmentId, selfHost),
    federationEnabled: true,
    channels,
    members,
    createdAt: server.createdAt.toISOString(),
  };
}

// --- helpers ---------------------------------------------------------------

interface EnvelopePrelude {
  fromInstance: string;
  eventType: EnvelopeEventType;
  nonce: string;
  payload: unknown;
}

/**
 * Cheap structural check used before any DB or crypto work. Returns the
 * fields we need to route the request; full schema validation happens
 * later via `verifyTwoLayerMessageEnvelope`.
 */
function parseEnvelopePrelude(body: unknown): EnvelopePrelude {
  // The wire-shape match the verifyTwoLayerMessageEnvelope uses internally;
  // we don't validate signatures here, just enough to get fromInstance +
  // eventType out so we can fail fast.
  //
  // Note `payload` is `any` rather than `unknown`: zod marks an `unknown`
  // schema field as optional in the resulting type (the `?:` shape), which
  // makes the value not assignable to a required field downstream. We get
  // the same runtime semantics with `z.any()` here and pull the typed
  // payload out of `verifyTwoLayerMessageEnvelope` later.
  const preludeSchema = z.object({
    fromInstance: z.string().min(1).max(253),
    eventType: z.enum(ENVELOPE_EVENT_TYPES),
    nonce: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/),
    payload: z.any(),
  });
  const parsed = preludeSchema.safeParse(body);
  if (!parsed.success) {
    throw new FederationInboundError(
      'bad_envelope',
      `envelope shape invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data as EnvelopePrelude;
}
