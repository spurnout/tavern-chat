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
import { prisma as defaultPrisma } from '@tavern/db';
import {
  canonicalize,
  verifyTwoLayerMessageEnvelope,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import {
  ENVELOPE_EVENT_TYPES,
  type EnvelopeEventType,
  messageCreatePayloadSchema,
  messageDeletePayloadSchema,
  messageUpdatePayloadSchema,
  reactionAddPayloadSchema,
  reactionRemovePayloadSchema,
  type MessageCreatePayload,
  type MessageDeletePayload,
  type MessageUpdatePayload,
  type ReactionAddPayload,
  type ReactionRemovePayload,
  ulid,
} from '@tavern/shared';
import { z } from 'zod';
import { ensureUserForRemoteUser } from './remote-user-upsert.js';
import {
  computeEffectiveFederation,
  type FederationMode,
} from './federation-outbox.js';
import { FederationProfileService } from './federation-profile.js';
import { gatewayBroker } from './gateway-broker.js';
import { serializeMessage } from '../lib/serializers.js';

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
  | 'replay' // 409 — (peerInstanceId, nonce) already logged
  | 'unknown_channel' // 404 — payload references a channelId we don't have
  | 'unknown_message' // 404 — payload references a messageId we don't have
  | 'federation_off' // 403 — channel federation effective state is OFF
  | 'not_a_member' // 403 — author isn't a member of channel's server
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
  prisma?: PrismaClient;
}

export interface ProcessEnvelopeResult {
  status: number;
  body?: unknown;
}

export class FederationInboundService {
  private readonly prisma: PrismaClient;
  private readonly profile: FederationProfileService;

  constructor(opts: FederationInboundServiceOptions) {
    this.prisma = opts.prisma ?? defaultPrisma;
    this.profile = opts.profile;
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
    const authorRemoteUserId = handler.extractAuthorRemoteUserId(preCheck.payload);
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
        });
      });
      result = txOutput.result;
      postCommit = txOutput.postCommit ?? null;
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
 */
export interface HandlerOutput {
  result: ProcessEnvelopeResult;
  postCommit?: PostCommitAction;
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
  extractAuthorRemoteUserId: (payload: unknown) => string | null;
  handle: (input: {
    envelope: TwoLayerSignedEnvelope<z.infer<TSchema>>;
    payload: z.infer<TSchema>;
    peer: { id: string };
    remoteUser: NonNullable<
      Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>
    >;
    tx: Prisma.TransactionClient;
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
  // Phase 1-2 envelopes (peering.*, profile.*) flow through their own
  // dedicated routes and never reach this handler map. They are intentionally
  // omitted; an attacker reusing those event types here gets a 501.
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
}): Promise<HandlerOutput> {
  const { envelope, payload, peer, remoteUser, tx } = input;

  // Channel must exist locally. Phase 3 requires the receiving instance to
  // have a mirror Channel row already; Phase 4 will introduce federated
  // invites that create the row on-demand.
  const channel = await tx.channel.findUnique({
    where: { id: payload.channelId },
    select: {
      id: true,
      serverId: true,
      federationMode: true,
      server: { select: { federationEnabled: true } },
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

  // Critically: do NOT call fanOutMessageCreate here. The originInstanceId
  // field is the marker — Phase 3 has no relay, the origin home instance
  // is responsible for delivering to every peer directly. The outbound path
  // in routes/messages.ts only fires from the local CREATE handler.
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

  const existing = await tx.message.findUnique({
    where: { id: payload.messageId },
    select: {
      id: true,
      serverId: true,
      channelId: true,
      authorId: true,
      deletedAt: true,
      author: { select: { remoteUserId: true } },
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

  if (emoji.startsWith('custom:')) {
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
