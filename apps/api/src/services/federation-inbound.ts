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
 *      replay window, the payload shape, and the timestamps.
 *   5. Insert the envelope-log row. The `unique(peerInstanceId, nonce)`
 *      constraint is the replay protection — a duplicate raises Prisma `P2002`
 *      which we translate to 409.
 *   6. Dispatch to the event-type handler. The handler is responsible for the
 *      side-effects (persist, broadcast, update `RemoteUser.lastSeenAt`). It
 *      returns the HTTP status + optional body that the route layer renders.
 *
 * Why a dispatcher map: P3-8 (message.update + message.delete) and P3-9
 * (reaction.add + reaction.remove) both register handlers by adding a key to
 * `HANDLERS`. The route shell, signature verification, peer lookup, and
 * envelope-log write all stay in this file — they're not duplicated per
 * event type.
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
  type MessageCreatePayload,
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
  | 'federation_off' // 403 — channel federation effective state is OFF
  | 'not_a_member' // 403 — author isn't a member of channel's server
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

    const verified = verifyTwoLayerMessageEnvelope({
      envelope: body,
      peerInstancePublicKeyRaw: Buffer.from(peer.instanceKey),
      authorPublicKeyRaw: Buffer.from(remoteUserRow.publicKey),
      payloadSchema: handler.payloadSchema,
    });
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

    // Replay protection. We insert FIRST and dispatch SECOND so a duplicate
    // envelope never reaches the handler.
    const payloadHash = createHash('sha256')
      .update(canonicalize(verified.envelope.payload as unknown))
      .digest();
    try {
      await this.prisma.federationEnvelopeLog.create({
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
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new FederationInboundError(
          'replay',
          'nonce already seen for this peer',
        );
      }
      throw err;
    }

    // Hand off to the per-event-type handler.
    return handler.handle({
      envelope: verified.envelope,
      payload: verified.payload,
      peer,
      remoteUser: remoteUserRow,
      prisma: this.prisma,
    });
  }
}

// --- handler map -------------------------------------------------------------

/**
 * A handler bundles three things: the payload schema (passed into
 * `verifyTwoLayerMessageEnvelope`), an extractor for the author id (used for
 * the public-key cache lookup before signature verification), and the
 * side-effect step that runs after the envelope is fully verified + logged.
 *
 * Adding a new event type in P3-8 / P3-9 means adding one entry here. The
 * route shell, signature verification, and replay-log write all stay in
 * `processEnvelope` and don't need to be touched.
 */
interface InboundHandler<TSchema extends z.ZodTypeAny> {
  payloadSchema: TSchema;
  extractAuthorRemoteUserId: (payload: unknown) => string | null;
  handle: (input: {
    envelope: TwoLayerSignedEnvelope<z.infer<TSchema>>;
    payload: z.infer<TSchema>;
    peer: { id: string };
    remoteUser: Awaited<ReturnType<PrismaClient['remoteUser']['findUnique']>>;
    prisma: PrismaClient;
  }) => Promise<ProcessEnvelopeResult>;
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
  // P3-8 — 'message.update', 'message.delete'
  // P3-9 — 'reaction.add', 'reaction.remove'
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
  prisma: PrismaClient;
}): Promise<ProcessEnvelopeResult> {
  const { envelope, payload, peer, remoteUser, prisma } = input;

  // Channel must exist locally. Phase 3 requires the receiving instance to
  // have a mirror Channel row already; Phase 4 will introduce federated
  // invites that create the row on-demand.
  const channel = await prisma.channel.findUnique({
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
  const localUser = await ensureUserForRemoteUser(remoteUser, prisma);
  const member = await prisma.serverMember.findUnique({
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
  const existingMessage = await prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { id: true },
  });
  if (existingMessage) {
    // Touch lastSeenAt even on idempotent path — the peer DID see this user
    // active when they signed the envelope.
    await prisma.remoteUser.update({
      where: { id: remoteUser.id },
      data: { lastSeenAt: new Date() },
    });
    return { status: 200, body: { ok: true, data: { id: existingMessage.id, deduplicated: true } } };
  }

  // The "instance signature" (envelope.signature) is the canonical proof
  // that this content was signed by the origin instance. Persisting it on
  // the Message row lets us audit later — and lets future moderation hooks
  // verify the row without re-fetching the envelope.
  const signatureBytes = Buffer.from(envelope.signature, 'base64');
  const messageRow = await prisma.message.create({
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

  // Touch the cache so the next inbound event for this user takes the warm
  // path. Cheaper than going around through the profile service again.
  await prisma.remoteUser.update({
    where: { id: remoteUser.id },
    data: { lastSeenAt: new Date() },
  });

  // Pull the full row shape `serializeMessage` expects. We need the relations
  // to render a wire DTO that matches the local CREATE path.
  const fullRow = await prisma.message.findUniqueOrThrow({
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
  gatewayBroker.publish({
    type: 'MESSAGE_CREATE',
    serverId: channel.serverId,
    channelId: channel.id,
    data: dto,
  });

  // Critically: do NOT call fanOutMessageCreate here. The originInstanceId
  // field is the marker — Phase 3 has no relay, the origin home instance
  // is responsible for delivering to every peer directly. The outbound path
  // in routes/messages.ts only fires from the local CREATE handler.
  return { status: 200, body: { ok: true, data: { id: messageRow.id } } };
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
