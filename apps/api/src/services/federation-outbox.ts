/**
 * Federation outbox fan-out helpers.
 *
 * Shared between the message create / update / delete handlers (P3-6, P3-8) and
 * the reaction handlers (P3-9). Keeps the gate logic, peer lookup, and enqueue
 * call in one place so each call site stays a single helper invocation.
 *
 * Design notes:
 *   - The fan-out is best-effort. Every entry-point wraps the helper in a
 *     try/catch and logs; we never let federation errors break the local
 *     write path. The caller has already committed and broadcast locally by
 *     the time we reach here.
 *   - "Effective federation" combines the server flag with the per-channel
 *     override. The mapping is documented next to `computeEffectiveFederation`.
 *   - Peer lookup returns DISTINCT instances, not members. Two remote members
 *     from the same peer collapse to a single enqueue per event.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@tavern/db';
import type { EnvelopeEventType } from '@tavern/shared';
import {
  channelCreatePayloadSchema,
  channelDeletePayloadSchema,
  channelUpdatePayloadSchema,
  dmCreatePayloadSchema,
  dmMessageCreatePayloadSchema,
  dmMessageDeletePayloadSchema,
  dmMessageUpdatePayloadSchema,
  memberAddPayloadSchema,
  memberRemovePayloadSchema,
  messageCreatePayloadSchema,
  messageDeletePayloadSchema,
  messageUpdatePayloadSchema,
  reactionAddPayloadSchema,
  reactionRemovePayloadSchema,
  serverUpdatePayloadSchema,
  ulid,
} from '@tavern/shared';
import type { QueueClient } from './queues.js';

export type FederationMode = 'inherit' | 'force_on' | 'force_off';

/**
 * Resolve the effective federation state for one channel/server pair.
 *
 *   force_off → never federate (channel-level kill switch)
 *   force_on  → always federate, even if the server flag is off
 *   inherit   → federate iff the server flag is on
 */
export function computeEffectiveFederation(
  serverFederationEnabled: boolean,
  channelMode: FederationMode,
): boolean {
  if (channelMode === 'force_off') return false;
  if (channelMode === 'force_on') return true;
  return serverFederationEnabled === true;
}

/**
 * Find the set of distinct peered RemoteInstance ids that have at least one
 * ServerMember in this server. The author of the local message is implicitly
 * filtered out — they're local, so `user.remoteInstanceId` is null.
 *
 * Returns an empty array if there are no remote members or no peered peers.
 */
export async function findPeersWithRemoteMembers(serverId: string): Promise<string[]> {
  const rows = await prisma.serverMember.findMany({
    where: {
      serverId,
      user: {
        remoteInstanceId: { not: null },
        remoteInstance: { status: 'peered' },
      },
    },
    select: { user: { select: { remoteInstanceId: true } } },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    const id = r.user.remoteInstanceId;
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * Resolve the set of peer RemoteInstance ids that should receive a per-message
 * fan-out for THIS channel. Diverges based on the channel's mirror provenance:
 *
 *   - HOME channel (`originInstanceId == null`): we own T. Fan out to every
 *     peered RemoteInstance that has at least one ServerMember in T —
 *     identical to the Phase 3 behaviour `findPeersWithRemoteMembers` returned
 *     directly.
 *
 *   - MIRROR channel (`originInstanceId != null`): we are a B-side mirror of
 *     a server homed on another peer. The HOME is the single authoritative
 *     target — they accept the message, persist it as their canonical copy,
 *     and then relay it via `fanOutMessageCreateRelay` (P4-13) to every OTHER
 *     peer of T. Fanning out directly to T's other peers from B would
 *     duplicate work AT BEST and risk diverging signatures / orderings.
 *
 * Mirror branch returns an empty array when the home's `RemoteInstance.status`
 * is anything other than `peered` (revoked / pending). The message stays
 * local on this instance; an operator re-peering with A will not retroactively
 * deliver this message, which is acceptable — at-most-once on the mirror
 * authoring side, identical to the Phase 3 gate when a peer goes offline.
 */
export async function findFanOutTargetsForChannel(channel: {
  serverId: string;
  originInstanceId: string | null;
}): Promise<string[]> {
  if (channel.originInstanceId) {
    // Mirror channel — single target: the home instance, only if peered.
    // A non-peered home (revoked / pending) silently drops the fan-out, in
    // line with how Phase 3 drops outbound traffic to non-peered remote
    // members. The local write + broadcast already happened — re-peering
    // does NOT retroactively replay.
    const home = await prisma.remoteInstance.findUnique({
      where: { id: channel.originInstanceId },
      select: { id: true, status: true },
    });
    if (!home || home.status !== 'peered') return [];
    return [home.id];
  }
  return findPeersWithRemoteMembers(channel.serverId);
}

export interface FanOutMessageCreateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  channelId: string;
  /**
   * P4-14 — the channel's mirror provenance (Channel.originInstanceId). When
   * non-null this is a MIRROR channel and the fan-out targets ONLY the home
   * instance; the home then relays to other peers via P4-13. When null (or
   * omitted) the channel is locally owned and fan-out covers every peer with
   * a remote member in T, identical to Phase 3 behaviour. Defaults to null
   * for forward-compat with call sites that haven't been updated yet.
   */
  channelOriginInstanceId?: string | null;
  messageId: string;
  authorUserId: string;
  authorUsername: string;
  content: string;
  createdAt: Date;
  replyToMessageId: string | null;
  log: FastifyBaseLogger;
  /**
   * Defence-in-depth: the instance-level FEDERATION_ENABLED flag. The primary
   * gate lives in the route call sites (they don't even wire `queues` /
   * `selfHost` when federation is off), but a `force_on` channel could
   * otherwise leak past `computeEffectiveFederation` if a future code path
   * threaded `deps` in without re-checking the instance flag. When this is
   * explicitly `false`, the helper short-circuits with a log and returns.
   * When omitted (`undefined`), behavior is unchanged — callers that already
   * gate on the instance flag don't need to thread anything through.
   */
  federationEnabledOnInstance?: boolean;
}

/**
 * Build the federation message.create envelope payload + enqueue one outbox
 * job per peer. Caller has already verified that the message is on a federated
 * channel (see `gateMessageFederation`).
 *
 * The payload shape MUST stay aligned with `messageCreatePayloadSchema` in
 * `packages/shared/src/federation/messages.ts`. We parse it here so a drift in
 * the schema fails loudly at the source instance rather than at every peer.
 */
export async function fanOutMessageCreate(input: FanOutMessageCreateInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { messageId: input.messageId, serverId: input.serverId, eventType: 'message.create' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  // P4-14 — mirror channels target ONLY the home (which then relays via
  // P4-13); home channels keep Phase 3's broad fan-out to every peer with a
  // remote member. `findFanOutTargetsForChannel` encapsulates that split.
  const peerIds = await findFanOutTargetsForChannel({
    serverId: input.serverId,
    originInstanceId: input.channelOriginInstanceId ?? null,
  });
  if (peerIds.length === 0) return;

  // The home instance speaks its OWN ULIDs for channel + message ids. Receiving
  // peers map these to their own row ids; the original is preserved alongside
  // the signature so edits and deletes can be keyed back to the same envelope.
  const payload = messageCreatePayloadSchema.parse({
    authorRemoteUserId: `${input.authorUsername}@${input.selfHost}`,
    channelId: input.channelId,
    messageId: input.messageId,
    content: input.content,
    replyToMessageId: input.replyToMessageId,
    createdAt: input.createdAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'message.create';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.messageId,
        peerInstanceId,
        eventType,
        authorUserId: input.authorUserId,
        payload,
      });
    } catch (err: unknown) {
      // Per-peer failures must not stop the loop — one bad peer should not
      // strand a message that could reach the others.
      // Pino's default `err` serializer extracts message + stack + name from
      // an Error; pre-flattening to a string would drop the stack trace.
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, messageId: input.messageId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

// --- P4-13 — home-instance message relay ------------------------------------
//
// When THIS instance is the home of T (Server.originInstanceId IS NULL) and
// receives an inbound `message.create` from one of T's peers, we are the
// authoritative hub: we must forward the message to every OTHER peer that has
// a member in T so they see it too.
//
// Two crucial differences from the local-author fan-out above:
//
//   1. The user signature is NOT recomputed. The original author (e.g.
//      bob@b) is a remote user; we don't hold his private key. We pass his
//      pre-existing signature straight through via `preservedUserSignature`
//      so each receiving peer can verify "the author really was bob@b"
//      against bob's published key from his home instance.
//
//   2. The relayed payload is byte-identical to the inbound payload. If we
//      changed any field — even reformatted the JSON differently — bob's
//      signature would stop verifying because it was computed over the
//      EXACT canonical bytes of the original payload. The relay helper
//      threads the original payload through as `unknown` and the dispatcher
//      re-canonicalises it consistently (same canonicalize routine on both
//      sides). The receiver verifies against THEIR canonicalisation of
//      whatever bytes arrive, which round-trips through the same algorithm.
//
//   3. We sign the OUTER envelope with this instance's instance key (because
//      `fromInstance = selfHost` — we're the sender of THIS hop). The
//      receiver verifies that signature against our published instance key,
//      establishing "this came from the home of T".
//
// `excludePeerInstanceId` is the originating peer's RemoteInstance.id —
// dropped from the fan-out so we don't echo back the message we just
// received from them.

export interface FanOutMessageCreateRelayInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /**
   * The Message row that was just persisted on the inbound side — the
   * helper uses its id as the BullMQ dedupe / log key. The payload itself
   * is NOT derived from this row (that would canonicalise differently
   * from the inbound payload and break the preserved user signature);
   * it's passed in separately as `originalPayload`.
   */
  messageId: string;
  /**
   * The payload from the verified inbound envelope, threaded through
   * unchanged. MUST be byte-equivalent (same canonical form) to what the
   * original author signed; the inbound handler took it straight from
   * the verified envelope's `payload` field so this invariant holds by
   * construction.
   */
  originalPayload: unknown;
  /**
   * The base64 user signature lifted directly off the verified inbound
   * envelope. Threaded into `preservedUserSignature` on the BullMQ job;
   * the dispatcher passes it to `buildTwoLayerMessageEnvelope` so each
   * relay envelope carries the ORIGINAL author signature unchanged.
   */
  originalUserSignature: string;
  /**
   * The originating peer's RemoteInstance.id — dropped from the fan-out
   * set so the relay doesn't echo the message back to whoever sent it.
   * (No double-hop: each peer learns each event exactly once per relay
   * step.)
   */
  excludePeerInstanceId: string;
  /**
   * For routing/log keying: the local User.id corresponding to the remote
   * author. The dispatcher does NOT call `userKeys.loadKeyFor()` on this
   * (the preserved signature short-circuits it), but the field still
   * matters for log correlation and BullMQ job inspection.
   */
  authorUserId: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a relayed `message.create` envelope from the HOME of T to every
 * peered instance with a remote member in T, EXCLUDING the originating peer.
 * The caller (inbound `handleMessageCreate` postCommit) has already verified:
 *   - `server.federationEnabled === true`
 *   - `server.originInstanceId === null` (we are the home — mirrors don't
 *     relay, that would re-send back to the home and trigger a loop / waste)
 *   - the inbound envelope itself was fully verified (two-layer signatures
 *     OK), so `originalPayload` + `originalUserSignature` form a valid pair
 *     for every receiving peer.
 *
 * Per-peer enqueue is best-effort with try/catch (matches the rest of the
 * fan-out helpers): one bad peer must not strand the relay to the others.
 */
export async function fanOutMessageCreateRelay(
  input: FanOutMessageCreateRelayInput,
): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { messageId: input.messageId, serverId: input.serverId, eventType: 'message.create', relay: true },
      'federation relay skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const allPeerIds = await findPeersWithRemoteMembers(input.serverId);
  const peerIds = allPeerIds.filter((id) => id !== input.excludePeerInstanceId);
  if (peerIds.length === 0) return;

  // Parse the payload through the wire schema to fail loudly if the inbound
  // shape ever drifts from what the create handler expects — better to
  // explode here at the relay site than at every receiving peer. The parse
  // result is discarded (we relay `originalPayload` unchanged so the
  // preserved user signature still verifies against the canonical bytes the
  // author actually signed; reusing `parsed` could subtly reorder fields).
  messageCreatePayloadSchema.parse(input.originalPayload);

  const eventType: EnvelopeEventType = 'message.create';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.messageId,
        peerInstanceId,
        eventType,
        // Fresh nonce per peer — the inbound envelope's nonce was scoped to
        // the originating peer's replay log on US; each relay envelope is
        // a NEW envelope from US to each target peer and needs its own
        // identifier. (BullMQ jobId defaults to `nonce ?? messageId`, so
        // without this two peers' relays of the same message would
        // collapse to one job.)
        nonce: ulid(),
        authorUserId: input.authorUserId,
        payload: input.originalPayload,
        preservedUserSignature: input.originalUserSignature,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, messageId: input.messageId, eventType, relay: true },
        'federation relay enqueue failed for peer',
      );
    }
  }
}

export interface FanOutMessageUpdateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /** P4-14 — see `FanOutMessageCreateInput.channelOriginInstanceId`. */
  channelOriginInstanceId?: string | null;
  messageId: string;
  authorUserId: string;
  authorUsername: string;
  content: string;
  editedAt: Date;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `message.update` envelope to every peered instance that has a
 * remote member in this server. Mirrors `fanOutMessageCreate`:
 *   - same peer-discovery query (`findPeersWithRemoteMembers`)
 *   - same per-peer try/catch so one bad peer cannot strand the others
 *   - payload shape validated through the shared zod schema so drift between
 *     this site and `packages/shared` fails loudly at the source instance.
 *
 * Caller is responsible for gating on (a) effective federation, (b) "this
 * isn't a DM", and (c) `originInstanceId IS NULL` (Phase 3 has no relay —
 * edits to inbound federated messages are NOT re-broadcast; every peer learns
 * directly from the origin instance).
 */
export async function fanOutMessageUpdate(input: FanOutMessageUpdateInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { messageId: input.messageId, serverId: input.serverId, eventType: 'message.update' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  // P4-14 — edits in mirror channels go to the home; home relays via P4-13.
  const peerIds = await findFanOutTargetsForChannel({
    serverId: input.serverId,
    originInstanceId: input.channelOriginInstanceId ?? null,
  });
  if (peerIds.length === 0) return;

  const payload = messageUpdatePayloadSchema.parse({
    authorRemoteUserId: `${input.authorUsername}@${input.selfHost}`,
    messageId: input.messageId,
    content: input.content,
    editedAt: input.editedAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'message.update';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.messageId,
        peerInstanceId,
        eventType,
        authorUserId: input.authorUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, messageId: input.messageId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutMessageDeleteInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /** P4-14 — see `FanOutMessageCreateInput.channelOriginInstanceId`. */
  channelOriginInstanceId?: string | null;
  messageId: string;
  /**
   * The User.id of the actor performing the delete. For P3-8 this MUST be
   * the original author (moderator deletes are not federated in Phase 3 —
   * see Phase 7 deferral). The caller is responsible for that gate; the
   * helper just signs with whichever key it's pointed at.
   */
  actorUserId: string;
  actorUsername: string;
  deletedAt: Date;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `message.delete` envelope to every peered instance that has a
 * remote member in this server. Same shape and gating contract as
 * `fanOutMessageUpdate`.
 *
 * Note the payload uses `actorRemoteUserId` (not `authorRemoteUserId`) because
 * Phase 7 will introduce moderator deletes — the actor isn't always the
 * author. In Phase 3 we only fan out author-initiated deletes; the caller
 * enforces that gate.
 */
export async function fanOutMessageDelete(input: FanOutMessageDeleteInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { messageId: input.messageId, serverId: input.serverId, eventType: 'message.delete' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  // P4-14 — deletes in mirror channels go to the home; home relays via P4-13.
  const peerIds = await findFanOutTargetsForChannel({
    serverId: input.serverId,
    originInstanceId: input.channelOriginInstanceId ?? null,
  });
  if (peerIds.length === 0) return;

  const payload = messageDeletePayloadSchema.parse({
    actorRemoteUserId: `${input.actorUsername}@${input.selfHost}`,
    messageId: input.messageId,
    deletedAt: input.deletedAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'message.delete';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.messageId,
        peerInstanceId,
        eventType,
        authorUserId: input.actorUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, messageId: input.messageId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutReactionAddInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /** P4-14 — see `FanOutMessageCreateInput.channelOriginInstanceId`. */
  channelOriginInstanceId?: string | null;
  messageId: string;
  /**
   * The User.id of the actor who added the reaction. Sign + envelope-author
   * routing both flow from this id; the helper itself does not validate that
   * the user is the local author of the message (a reaction's actor IS the
   * reactor, not the original message author).
   */
  actorUserId: string;
  actorUsername: string;
  emoji: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `reaction.add` envelope to every peered instance that has a
 * remote member in this server. Same gating contract as the message helpers:
 *   - caller verified effective federation,
 *   - caller verified this is a server message (not a DM — DMs are Phase 5),
 *   - caller verified the underlying message is locally-originated
 *     (`originInstanceId IS NULL`) — Phase 3 has no relay, so a reaction on
 *     an inbound federated message is NOT re-broadcast (each peer hears the
 *     reaction directly from the reactor's home instance, which is THIS
 *     instance for a local reactor).
 *
 * The actor identity is `<localpart>@<selfHost>` — the reactor's qualified id.
 * This differs from message edits/deletes, where the actor is always the
 * original author. A reaction's actor is whoever clicked the emoji.
 */
export async function fanOutReactionAdd(input: FanOutReactionAddInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { messageId: input.messageId, serverId: input.serverId, eventType: 'reaction.add' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  // P4-14 — reactions in mirror channels go to the home; home relays via P4-13.
  const peerIds = await findFanOutTargetsForChannel({
    serverId: input.serverId,
    originInstanceId: input.channelOriginInstanceId ?? null,
  });
  if (peerIds.length === 0) return;

  const payload = reactionAddPayloadSchema.parse({
    actorRemoteUserId: `${input.actorUsername}@${input.selfHost}`,
    messageId: input.messageId,
    emoji: input.emoji,
  });

  const eventType: EnvelopeEventType = 'reaction.add';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.messageId,
        peerInstanceId,
        eventType,
        authorUserId: input.actorUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, messageId: input.messageId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutReactionRemoveInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /** P4-14 — see `FanOutMessageCreateInput.channelOriginInstanceId`. */
  channelOriginInstanceId?: string | null;
  messageId: string;
  actorUserId: string;
  actorUsername: string;
  emoji: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `reaction.remove` envelope. Same shape and gating contract as
 * `fanOutReactionAdd`. The receiving handler treats the remove as idempotent
 * (matches the local DELETE pattern in `routes/reactions.ts`) so a missing
 * row on the peer is not an error.
 */
export async function fanOutReactionRemove(input: FanOutReactionRemoveInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { messageId: input.messageId, serverId: input.serverId, eventType: 'reaction.remove' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  // P4-14 — reactions in mirror channels go to the home; home relays via P4-13.
  const peerIds = await findFanOutTargetsForChannel({
    serverId: input.serverId,
    originInstanceId: input.channelOriginInstanceId ?? null,
  });
  if (peerIds.length === 0) return;

  const payload = reactionRemovePayloadSchema.parse({
    actorRemoteUserId: `${input.actorUsername}@${input.selfHost}`,
    messageId: input.messageId,
    emoji: input.emoji,
  });

  const eventType: EnvelopeEventType = 'reaction.remove';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.messageId,
        peerInstanceId,
        eventType,
        authorUserId: input.actorUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, messageId: input.messageId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

// --- P4-9 — server/channel lifecycle fan-out --------------------------------
//
// These helpers mirror the message-fan-out shape but route mirror-server
// lifecycle envelopes (server.update, channel.create/update/delete) to peers
// that hold at least one ServerMember in T. The caller has already gated on:
//   - `server.federationEnabled` (server-level toggle)
//   - `server.originInstanceId === null` (this instance owns T; we don't
//     push updates for somebody else's mirror)
//   - FEDERATION_ENABLED at the instance config level (gated again inside
//     the helper as defence-in-depth, mirroring the message helpers).
//
// Author identity for the user-layer signature is the SERVER OWNER, because
// the inbound mirror lifecycle handler resolves the author by looking up
// `server.ownerUserId` (see `resolveMirrorOwner` in `federation-inbound.ts`).
// The route layer reads the owner's id + username and passes them through;
// the helper itself does not re-resolve to keep the contract explicit.
//
// `messageId` on the outbox job is reused as the dedupe / log key. For these
// envelopes there is no underlying Message row — we pass the SERVER id for
// `server.update` and the CHANNEL id for the three channel envelopes, since
// those are the natural per-event identifiers an operator will grep for.
// `nonce` is set explicitly to a fresh ULID per call so multiple PATCHes of
// the same server / channel don't collapse to a single BullMQ job (the
// default jobId derives from the nonce).

export interface FanOutServerUpdateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /** The server owner's User.id — used to load the user-key signer. */
  ownerUserId: string;
  /** The server owner's username — used to build the qualified author id. */
  ownerUsername: string;
  /** Updated fields. All optional — only changed fields go on the wire. */
  name?: string;
  description?: string | null;
  iconUrl?: string | null;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `server.update` envelope to every peered instance that has a
 * ServerMember in this server. Caller has already verified:
 *   - `server.federationEnabled === true`
 *   - `server.originInstanceId === null` (we own T; do not push updates for
 *     somebody else's mirror)
 *   - FEDERATION_ENABLED at the instance level (defence-in-depth inside).
 *
 * The user-layer signer is the server OWNER (matches the inbound resolver in
 * `federation-inbound.ts:resolveMirrorOwner`). `authorRemoteUserId` on the
 * wire is implicit — the receiver derives it from envelope `fromInstance` +
 * the mirror's owner row.
 */
export async function fanOutServerUpdate(input: FanOutServerUpdateInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { serverId: input.serverId, eventType: 'server.update' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
  if (peerIds.length === 0) return;

  const payload = serverUpdatePayloadSchema.parse({
    serverId: input.serverId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.iconUrl !== undefined ? { iconUrl: input.iconUrl } : {}),
  });

  const eventType: EnvelopeEventType = 'server.update';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        // No Message row — use the serverId as the human-readable log key.
        messageId: input.serverId,
        peerInstanceId,
        eventType,
        // Fresh nonce per call so repeated PATCHes don't dedupe to a single
        // BullMQ job (the default `nonce ?? messageId` would collapse them).
        nonce: ulid(),
        authorUserId: input.ownerUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, serverId: input.serverId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutChannelCreateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  ownerUserId: string;
  ownerUsername: string;
  channel: {
    id: string;
    name: string;
    type: 'text' | 'forum';
    topic: string | null;
    position: number;
    federationMode: 'inherit' | 'force_on' | 'force_off';
    nsfw: boolean;
  };
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `channel.create` envelope to every peered instance that has a
 * ServerMember in this server. Caller has already verified that the server
 * is federated and not a mirror, and that the channel is text/forum (only
 * those two types are federation-eligible on the wire schema).
 */
export async function fanOutChannelCreate(input: FanOutChannelCreateInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { serverId: input.serverId, channelId: input.channel.id, eventType: 'channel.create' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
  if (peerIds.length === 0) return;

  const payload = channelCreatePayloadSchema.parse({
    serverId: input.serverId,
    channel: {
      id: input.channel.id,
      name: input.channel.name,
      type: input.channel.type,
      topic: input.channel.topic,
      position: input.channel.position,
      federationMode: input.channel.federationMode,
      nsfw: input.channel.nsfw,
    },
  });

  const eventType: EnvelopeEventType = 'channel.create';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        // Channel id is the natural log/dedupe key for channel envelopes.
        messageId: input.channel.id,
        peerInstanceId,
        eventType,
        nonce: ulid(),
        authorUserId: input.ownerUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, channelId: input.channel.id, serverId: input.serverId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutChannelUpdateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  channelId: string;
  ownerUserId: string;
  ownerUsername: string;
  /** Updated fields. All optional — only changed fields go on the wire. */
  name?: string;
  topic?: string | null;
  position?: number;
  federationMode?: 'inherit' | 'force_on' | 'force_off';
  nsfw?: boolean;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `channel.update` envelope. Critically, this fires REGARDLESS of
 * effective per-channel federation as long as the SERVER is federated. A
 * channel toggling its federationMode (including flipping to `force_off`) is
 * itself a `channel.update` event peers must learn about — without it, the
 * receiving side would keep expecting (and accepting) messages on a room
 * that has gone silent.
 */
export async function fanOutChannelUpdate(input: FanOutChannelUpdateInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { serverId: input.serverId, channelId: input.channelId, eventType: 'channel.update' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
  if (peerIds.length === 0) return;

  const payload = channelUpdatePayloadSchema.parse({
    serverId: input.serverId,
    channelId: input.channelId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.topic !== undefined ? { topic: input.topic } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(input.federationMode !== undefined ? { federationMode: input.federationMode } : {}),
    ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
  });

  const eventType: EnvelopeEventType = 'channel.update';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.channelId,
        peerInstanceId,
        eventType,
        nonce: ulid(),
        authorUserId: input.ownerUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, channelId: input.channelId, serverId: input.serverId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutChannelDeleteInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  channelId: string;
  ownerUserId: string;
  ownerUsername: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `channel.delete` envelope. Same gating contract as
 * `fanOutChannelUpdate`: server must be federated and not a mirror; the
 * per-channel federation override does not matter here (a deleted channel
 * is by definition no longer producing messages either way, and peers need
 * to know to tear down the mirror channel row).
 */
export async function fanOutChannelDelete(input: FanOutChannelDeleteInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { serverId: input.serverId, channelId: input.channelId, eventType: 'channel.delete' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
  if (peerIds.length === 0) return;

  const payload = channelDeletePayloadSchema.parse({
    serverId: input.serverId,
    channelId: input.channelId,
  });

  const eventType: EnvelopeEventType = 'channel.delete';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.channelId,
        peerInstanceId,
        eventType,
        nonce: ulid(),
        authorUserId: input.ownerUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, channelId: input.channelId, serverId: input.serverId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

// --- P4-10 — membership fan-out (member.add / member.remove) ----------------
//
// These helpers mirror the message-fan-out shape but route membership
// envelopes to peers that hold at least one ServerMember in T. Caller has
// already gated on:
//   - `server.federationEnabled` (server-level toggle)
//   - `server.originInstanceId === null` (this instance owns T; mirrors
//     don't fan out membership — the home is authoritative)
//   - FEDERATION_ENABLED at the instance config level (gated again inside
//     the helper as defence-in-depth, mirroring the other helpers).
//
// Author identity for the user-layer signature is the MEMBER themselves
// for add (the joiner) and the MODERATOR (or removed user, in the case of
// a future voluntary leave) for remove. P4-10 only ships moderator-driven
// removes, so the caller passes the actor's local User id + username.
//
// `excludePeerInstanceId` (member.add only) — when the inbound P4-7
// handler runs `member.join_request` from peer B, the joiner is already
// authoritatively known to B (they're B's own user). Fanning `member.add`
// back to B would be a no-op at best and confuse audit trails at worst.
// Set this to peer.id so we skip B; every OTHER peer of T receives the
// envelope. Local-invite + admin-add call sites pass undefined.
//
// `additionalPeerInstanceIds` (member.remove only) — when the removed
// member was themselves the only remote member on their home peer B,
// `findPeersWithRemoteMembers` no longer returns B after the delete. We
// still need B to learn about the removal (so its mirror state is
// consistent). The caller passes the removed user's home instance id (if
// remote) and the helper unions it into the peer set, deduping.

export interface FanOutMemberAddInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /**
   * Qualified id of the new member: `<localpart>@<host>`. For local
   * joiners the host is `selfHost`; for federated invite acceptance (P4-7)
   * the joiner is a remote user, so the host is the joiner's home peer.
   */
  memberRemoteUserId: string;
  /** Display name as it should appear on the remote roster. */
  memberDisplayName: string;
  /** Audited join timestamp — the ServerMember.joinedAt of the row we just inserted. */
  joinedAt: Date;
  /**
   * The User.id used to sign the user-layer envelope. The signing user
   * MUST be the joiner themselves (their key authorises the addition).
   * For local joiners this is `ctx.userId`; for inbound P4-7 it is the
   * synthetic local user id materialised from the joiner's RemoteUser row.
   */
  authorUserId: string;
  log: FastifyBaseLogger;
  /**
   * Optional peer to skip — used by the inbound P4-7 `member.join_request`
   * handler to avoid echoing `member.add` back to the joiner's home, which
   * already knows the join succeeded (it sent the request). Local /
   * admin-side adds leave this undefined.
   */
  excludePeerInstanceId?: string;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `member.add` envelope to every peered instance that has a
 * ServerMember in this server. Caller has already verified:
 *   - `server.federationEnabled === true`
 *   - `server.originInstanceId === null` (T isn't a mirror)
 *   - the ServerMember.create succeeded (the new member is in the roster)
 *   - the local MEMBER_ADD gateway broadcast already fired (best-effort,
 *     this fan-out is post-commit either way).
 *
 * The user-layer signer is the joiner. `findPeersWithRemoteMembers` runs
 * AFTER the insert so if the joiner is themselves a remote user their
 * home will be in the result — `excludePeerInstanceId` is how the P4-7
 * inbound handler keeps the envelope from echoing back to that home.
 */
export async function fanOutMemberAdd(input: FanOutMemberAddInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { serverId: input.serverId, eventType: 'member.add' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const allPeerIds = await findPeersWithRemoteMembers(input.serverId);
  const peerIds = input.excludePeerInstanceId
    ? allPeerIds.filter((id) => id !== input.excludePeerInstanceId)
    : allPeerIds;
  if (peerIds.length === 0) return;

  const payload = memberAddPayloadSchema.parse({
    serverId: input.serverId,
    memberRemoteUserId: input.memberRemoteUserId,
    memberDisplayName: input.memberDisplayName,
    joinedAt: input.joinedAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'member.add';
  for (const peerInstanceId of peerIds) {
    try {
      await input.queues.enqueueFederationOutbox({
        // No Message row — use the qualified member id as the human-readable
        // log key so an operator grepping for a join attempt can find it
        // alongside the audit entry.
        messageId: input.memberRemoteUserId,
        peerInstanceId,
        eventType,
        // Fresh nonce — repeated adds (e.g. an admin reinvites a user after
        // they were removed) must not collapse to a single BullMQ job.
        nonce: ulid(),
        authorUserId: input.authorUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, serverId: input.serverId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

export interface FanOutMemberRemoveInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  /** Qualified id of the removed member: `<localpart>@<host>`. */
  memberRemoteUserId: string;
  /**
   * Why the member is gone. P4-10 only fires for moderator-driven removes,
   * so 'kicked' and 'banned' are the in-scope values. 'left' is reserved
   * for a future voluntary-leave endpoint (not in Phase 4) — the wire
   * schema accepts it because the spec already covers the eventual
   * surface, and a peer kicking their own user fans out as 'left' to keep
   * the audit trail honest.
   */
  reason: 'kicked' | 'banned' | 'left';
  removedAt: Date;
  /**
   * The User.id used to sign the user-layer envelope. For moderator-driven
   * removes this is the moderator (so the receiving peer's audit trail
   * shows who acted). The matching qualified id on the wire is the
   * envelope's `authorRemoteUserId`; receivers cross-check the signing key
   * against `memberRemoteUserId` before applying the delete.
   */
  actorUserId: string;
  log: FastifyBaseLogger;
  /**
   * Extra peer ids to include in the fan-out, deduped with the result of
   * `findPeersWithRemoteMembers`. Used when the removed user was the ONLY
   * remote member from their home peer — without this, the post-delete
   * query no longer returns that peer and we would silently drop the
   * envelope to the one peer that most needs it.
   */
  additionalPeerInstanceIds?: string[];
  /**
   * Optional peer to drop from the fan-out — used by the inbound P4-12
   * `member.leave` handler so the envelope doesn't echo back to the
   * leaver's home, which already received the synchronous
   * `member.removed` ack and committed the local delete.
   *
   * Applied AFTER the union with `additionalPeerInstanceIds`, so callers
   * cannot accidentally re-add the excluded id by passing it on both
   * sides.
   */
  excludePeerInstanceId?: string;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `member.remove` envelope to every peered instance that had a
 * member in this server. Caller has already verified:
 *   - `server.federationEnabled === true`
 *   - `server.originInstanceId === null`
 *   - the ServerMember.delete succeeded
 *   - the local MEMBER_REMOVE gateway broadcast already fired.
 *
 * Peer-set composition: `findPeersWithRemoteMembers(serverId)` returns
 * peers with REMAINING remote members, AFTER the delete. We union that
 * with `additionalPeerInstanceIds` so the removed user's home (when the
 * removed user was the last remote member from that peer) still hears
 * about the removal. Dedup is by Set so callers can over-include safely.
 */
export async function fanOutMemberRemove(input: FanOutMemberRemoveInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { serverId: input.serverId, eventType: 'member.remove' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }
  const remainingPeerIds = await findPeersWithRemoteMembers(input.serverId);
  const seen = new Set<string>(remainingPeerIds);
  if (input.additionalPeerInstanceIds) {
    for (const id of input.additionalPeerInstanceIds) {
      if (id) seen.add(id);
    }
  }
  if (input.excludePeerInstanceId) {
    seen.delete(input.excludePeerInstanceId);
  }
  if (seen.size === 0) return;

  const payload = memberRemovePayloadSchema.parse({
    serverId: input.serverId,
    memberRemoteUserId: input.memberRemoteUserId,
    reason: input.reason,
    removedAt: input.removedAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'member.remove';
  for (const peerInstanceId of seen) {
    try {
      await input.queues.enqueueFederationOutbox({
        messageId: input.memberRemoteUserId,
        peerInstanceId,
        eventType,
        nonce: ulid(),
        authorUserId: input.actorUserId,
        payload,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      input.log.warn(
        { err: errObj, peerInstanceId, serverId: input.serverId, eventType },
        'federation fan-out enqueue failed for peer',
      );
    }
  }
}

// --- P5-3 — DM creation fan-out ---------------------------------------------
//
// When a local user opens a 1:1 DM with a remote user, we tell that user's
// home instance about the new DM channel. Unlike server-message fan-out there
// is exactly ONE peer involved (the other party's home) — no roster lookup,
// no relay. DM events don't relay in Phase 5; both sides talk directly to the
// shared DM channel from their respective homes.
//
// Capability gate: the peer must advertise the `dms` capability in their
// `RemoteInstance.capabilities` set (negotiated at peering time). A peer
// that's peered for server messaging but hasn't opted into DM federation
// gets a no-op + a warning log — the local DmChannel still exists, the user
// just can't receive remote messages on it until the peer opts in. We do
// NOT roll back the local DM: same defensive posture as the rest of the
// fan-out helpers, where peer-side problems never break the local write.

export interface FanOutDmCreateInput {
  queues: QueueClient;
  selfHost: string;
  /** Local DmChannel.id — the originating instance's id for the wire payload. */
  dmChannelId: string;
  /** Local User.id used to sign the user-layer envelope (the DM initiator). */
  initiatorUserId: string;
  /** Initiator's local username — combined with `selfHost` to form `<localpart>@<selfHost>`. */
  initiatorUsername: string;
  /** Recipient's qualified id — the remote user's `<localpart>@<host>` from RemoteUser. */
  recipientRemoteUserId: string;
  /** The remote user's home RemoteInstance.id — single fan-out target. */
  peerInstanceId: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `dm.create` envelope to the recipient's home instance. Caller has
 * already verified (a) the recipient is a remote user (User.remoteInstanceId
 * is set) and (b) the local DmChannel row was successfully created. The
 * helper itself:
 *   1. Defence-in-depth gate on the instance-level federation flag.
 *   2. Look up the peer; bail with a warning when the peer is not peered or
 *      does not advertise the `dms` capability. The local DM is unaffected.
 *   3. Build the wire payload and parse it through `dmCreatePayloadSchema`
 *      so a schema drift surfaces at the source instance.
 *   4. Enqueue ONE outbox job, keyed by `dmChannelId` so duplicate
 *      `findOrCreateDirectDm` calls (idempotent re-create) collapse to a
 *      single BullMQ jobId via the default `nonce ?? messageId` rule.
 */
export async function fanOutDmCreate(input: FanOutDmCreateInput): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      { dmChannelId: input.dmChannelId, peerInstanceId: input.peerInstanceId, eventType: 'dm.create' },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }

  // Peer must be peered AND advertise the `dms` capability. Either gate
  // failing is a no-op + warning (not a hard error) — the local DmChannel
  // stays valid, the user just doesn't get federated delivery yet.
  const peer = await prisma.remoteInstance.findUnique({
    where: { id: input.peerInstanceId },
    select: { id: true, status: true, capabilities: true, host: true },
  });
  if (!peer) {
    input.log.warn(
      { dmChannelId: input.dmChannelId, peerInstanceId: input.peerInstanceId, eventType: 'dm.create' },
      'dm.create fan-out skipped — peer RemoteInstance not found',
    );
    return;
  }
  if (peer.status !== 'peered') {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerStatus: peer.status,
        eventType: 'dm.create',
      },
      'dm.create fan-out skipped — peer is not peered',
    );
    return;
  }
  if (!peer.capabilities.includes('dms')) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerCapabilities: peer.capabilities,
        eventType: 'dm.create',
      },
      'dm.create fan-out skipped — peer does not advertise the `dms` capability',
    );
    return;
  }

  const payload = dmCreatePayloadSchema.parse({
    dmChannelId: input.dmChannelId,
    initiatorRemoteUserId: `${input.initiatorUsername}@${input.selfHost}`,
    recipientRemoteUserId: input.recipientRemoteUserId,
    createdAt: new Date().toISOString(),
  });

  const eventType: EnvelopeEventType = 'dm.create';
  try {
    await input.queues.enqueueFederationOutbox({
      // Use dmChannelId as the BullMQ jobId-dedupe key so an idempotent
      // re-create (alice clicks "open DM with bob" twice) collapses to a
      // single job per (dmChannel, peer) pair.
      messageId: input.dmChannelId,
      peerInstanceId: input.peerInstanceId,
      eventType,
      authorUserId: input.initiatorUserId,
      payload,
    });
  } catch (err: unknown) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    input.log.warn(
      {
        err: errObj,
        peerInstanceId: input.peerInstanceId,
        dmChannelId: input.dmChannelId,
        eventType,
      },
      'federation fan-out enqueue failed for peer',
    );
  }
}

// --- P5-5 — DM message create fan-out ---------------------------------------
//
// A local user sends a message in a 1:1 DM whose other party is a remote user.
// The local persist + gateway broadcast has already happened; this helper
// enqueues a single `dm.message.create` envelope to the OTHER party's home
// instance so the remote user can render the message.
//
// Phase 5 limitations baked in by the caller (not this helper):
//   - 1:1 DMs only (`DmChannel.kind === 'direct'`). Group DM federation is
//     out of scope; the route guard never reaches this helper for groups.
//   - exactly ONE peer target (the other member's home). No relay, no
//     multi-peer fan-out — both sides talk directly to the shared channel
//     from their respective homes, mirroring how `dm.create` itself flows.
//
// Capability gate: peer must advertise the `dms` capability (negotiated at
// peering time). A peer that's peered for `messages` only is treated the same
// way `fanOutDmCreate` treats it — no enqueue, warn log, local DM unaffected.
// We do NOT roll back the local message: the defence is the same as every
// other fan-out helper, peer-side problems never break the local write.

export interface FanOutDmMessageCreateInput {
  queues: QueueClient;
  selfHost: string;
  /** Local DmChannel.id — the originating instance's id for the wire payload. */
  dmChannelId: string;
  /** Local Message.id — used both on the wire and as the BullMQ jobId disambiguator. */
  messageId: string;
  /** Local User.id used to sign the user-layer envelope (the message author). */
  authorUserId: string;
  /** Author's local username — combined with `selfHost` to form `<localpart>@<selfHost>`. */
  authorUsername: string;
  /** Sanitised message content as persisted locally. */
  content: string;
  /** Optional reply-to pointer; the wire schema accepts null. */
  replyToMessageId: string | null;
  /** Local Message.createdAt — serialised as ISO on the wire. */
  createdAt: Date;
  /** The remote recipient's home RemoteInstance.id — single fan-out target. */
  peerInstanceId: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `dm.message.create` envelope to the recipient's home instance.
 * Caller has already verified (a) the DM channel is 1:1 (`kind === 'direct'`),
 * (b) the OTHER member is a remote user (User.remoteInstanceId set), and
 * (c) the local Message row + DM_MESSAGE_CREATE gateway broadcast already
 * fired. The helper itself:
 *   1. Defence-in-depth gate on the instance-level federation flag.
 *   2. Look up the peer; bail with a warning when the peer is not peered or
 *      does not advertise the `dms` capability. The local message is
 *      unaffected.
 *   3. Build the wire payload and parse it through
 *      `dmMessageCreatePayloadSchema` so a schema drift surfaces at the
 *      source instance.
 *   4. Enqueue ONE outbox job, keyed by `messageId` so repeated sends with
 *      the same local id collapse to a single BullMQ jobId via the default
 *      `nonce ?? messageId` rule.
 */
export async function fanOutDmMessageCreate(
  input: FanOutDmMessageCreateInput,
): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: input.peerInstanceId,
        eventType: 'dm.message.create',
      },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }

  // Peer must be peered AND advertise the `dms` capability. Either gate
  // failing is a no-op + warning (not a hard error) — the local message
  // stays valid, the user just doesn't get federated delivery.
  const peer = await prisma.remoteInstance.findUnique({
    where: { id: input.peerInstanceId },
    select: { id: true, status: true, capabilities: true, host: true },
  });
  if (!peer) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: input.peerInstanceId,
        eventType: 'dm.message.create',
      },
      'dm.message.create fan-out skipped — peer RemoteInstance not found',
    );
    return;
  }
  if (peer.status !== 'peered') {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerStatus: peer.status,
        eventType: 'dm.message.create',
      },
      'dm.message.create fan-out skipped — peer is not peered',
    );
    return;
  }
  if (!peer.capabilities.includes('dms')) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerCapabilities: peer.capabilities,
        eventType: 'dm.message.create',
      },
      'dm.message.create fan-out skipped — peer does not advertise the `dms` capability',
    );
    return;
  }

  const payload = dmMessageCreatePayloadSchema.parse({
    dmChannelId: input.dmChannelId,
    messageId: input.messageId,
    authorRemoteUserId: `${input.authorUsername}@${input.selfHost}`,
    content: input.content,
    replyToMessageId: input.replyToMessageId,
    createdAt: input.createdAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'dm.message.create';
  try {
    await input.queues.enqueueFederationOutbox({
      // Use messageId as the BullMQ jobId-dedupe key — repeated sends of
      // the same local id (idempotent retry) collapse to a single job per
      // (message, peer) pair.
      messageId: input.messageId,
      peerInstanceId: input.peerInstanceId,
      eventType,
      authorUserId: input.authorUserId,
      payload,
    });
  } catch (err: unknown) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    input.log.warn(
      {
        err: errObj,
        peerInstanceId: input.peerInstanceId,
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        eventType,
      },
      'federation fan-out enqueue failed for peer',
    );
  }
}

// --- P5-7 — DM message edit / delete fan-out --------------------------------
//
// Mirrors P3-8 (server message edit/delete fan-out) for the DM path. The
// gating story is identical to P5-5 (`fanOutDmMessageCreate`):
//   - exactly ONE peer target (the OTHER member's home); no relay, no
//     multi-peer fan-out.
//   - 1:1 DMs only (`DmChannel.kind === 'direct'`). The route guard never
//     reaches this helper for group DMs.
//   - capability gate: peer must advertise `dms`.
//   - peer must be `peered`.
//
// Author identity nuance: for both update and delete, the actor is BY
// CONSTRUCTION the original author. The PATCH route already rejects
// non-author edits, and the DELETE route gives DM messages no moderator
// override (only the author can delete their own DM posts — explicit in
// the existing handler). So the helper carries an `authorUserId` /
// `authorUsername` for update and `actorUserId` / `actorUsername` for
// delete, in line with the wire shape (delete's payload uses
// `actorRemoteUserId` because Phase 7 will introduce moderator deletes on
// the server-message path; DMs never get one).
//
// Federation provenance: a DM message stored locally with
// `originInstanceId != null` was authored by the REMOTE member (inbound
// from the peer who sent it). Since the PATCH/DELETE author-only checks
// reject any local user attempting to edit/delete it, we never reach this
// helper in the relay-style case — the only path here is "local author
// mutates a message they themselves wrote". No special-case for inbound
// rows is needed; the gate is the author check upstream.

export interface FanOutDmMessageUpdateInput {
  queues: QueueClient;
  selfHost: string;
  /** Local DmChannel.id — the originating instance's id for the wire payload. */
  dmChannelId: string;
  /** Local Message.id — used both on the wire and as the BullMQ jobId disambiguator. */
  messageId: string;
  /** Local User.id used to sign the user-layer envelope (the message author). */
  authorUserId: string;
  /** Author's local username — combined with `selfHost` to form `<localpart>@<selfHost>`. */
  authorUsername: string;
  /** Sanitised post-edit content as persisted locally. */
  content: string;
  /** Local Message.editedAt — serialised as ISO on the wire. */
  editedAt: Date;
  /** The remote recipient's home RemoteInstance.id — single fan-out target. */
  peerInstanceId: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `dm.message.update` envelope to the recipient's home instance.
 * Caller has already verified (a) the DM channel is 1:1, (b) the OTHER
 * member is a remote user, (c) the local Message row was updated, and
 * (d) the DM_MESSAGE_UPDATE gateway broadcast already fired. The helper:
 *   1. Defence-in-depth gate on the instance-level federation flag.
 *   2. Peer lookup; bail with a warning if not peered or no `dms` capability.
 *   3. Build + parse the payload through `dmMessageUpdatePayloadSchema`.
 *   4. Enqueue ONE outbox job, with a fresh nonce so consecutive edits
 *      don't collapse to a single BullMQ jobId (`nonce ?? messageId`).
 *
 * Same defensive posture as the rest: peer-side problems never break the
 * local edit. The local Message.editedAt has already been written when we
 * reach this helper.
 */
export async function fanOutDmMessageUpdate(
  input: FanOutDmMessageUpdateInput,
): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: input.peerInstanceId,
        eventType: 'dm.message.update',
      },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }

  const peer = await prisma.remoteInstance.findUnique({
    where: { id: input.peerInstanceId },
    select: { id: true, status: true, capabilities: true, host: true },
  });
  if (!peer) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: input.peerInstanceId,
        eventType: 'dm.message.update',
      },
      'dm.message.update fan-out skipped — peer RemoteInstance not found',
    );
    return;
  }
  if (peer.status !== 'peered') {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerStatus: peer.status,
        eventType: 'dm.message.update',
      },
      'dm.message.update fan-out skipped — peer is not peered',
    );
    return;
  }
  if (!peer.capabilities.includes('dms')) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerCapabilities: peer.capabilities,
        eventType: 'dm.message.update',
      },
      'dm.message.update fan-out skipped — peer does not advertise the `dms` capability',
    );
    return;
  }

  const payload = dmMessageUpdatePayloadSchema.parse({
    dmChannelId: input.dmChannelId,
    messageId: input.messageId,
    authorRemoteUserId: `${input.authorUsername}@${input.selfHost}`,
    content: input.content,
    editedAt: input.editedAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'dm.message.update';
  try {
    await input.queues.enqueueFederationOutbox({
      messageId: input.messageId,
      peerInstanceId: input.peerInstanceId,
      eventType,
      // Fresh nonce — without it, two consecutive edits would collapse to a
      // single BullMQ jobId (`nonce ?? messageId`) and the second edit could
      // silently disappear if the first job was still in-flight.
      nonce: ulid(),
      authorUserId: input.authorUserId,
      payload,
    });
  } catch (err: unknown) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    input.log.warn(
      {
        err: errObj,
        peerInstanceId: input.peerInstanceId,
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        eventType,
      },
      'federation fan-out enqueue failed for peer',
    );
  }
}

export interface FanOutDmMessageDeleteInput {
  queues: QueueClient;
  selfHost: string;
  /** Local DmChannel.id — the originating instance's id for the wire payload. */
  dmChannelId: string;
  /** Local Message.id — used both on the wire and as the BullMQ jobId disambiguator. */
  messageId: string;
  /**
   * The User.id of the actor performing the delete. For P5-7 this MUST be
   * the original author — DM messages have no moderator override (the
   * route's existing 403 enforces this). The helper signs with whichever
   * key it's pointed at; the gate is upstream.
   */
  actorUserId: string;
  actorUsername: string;
  /** Local Message.deletedAt — serialised as ISO on the wire. */
  deletedAt: Date;
  /** The remote recipient's home RemoteInstance.id — single fan-out target. */
  peerInstanceId: string;
  log: FastifyBaseLogger;
  /** Defence-in-depth, see `FanOutMessageCreateInput.federationEnabledOnInstance`. */
  federationEnabledOnInstance?: boolean;
}

/**
 * Fan out a `dm.message.delete` envelope to the recipient's home instance.
 * Same shape and gating contract as `fanOutDmMessageUpdate`. The payload
 * uses `actorRemoteUserId` to match the server-side `message.delete` wire
 * shape (where Phase 7 will introduce moderator deletes); for DMs in P5-7
 * the actor is always the original author by route-level gate.
 */
export async function fanOutDmMessageDelete(
  input: FanOutDmMessageDeleteInput,
): Promise<void> {
  if (input.federationEnabledOnInstance === false) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: input.peerInstanceId,
        eventType: 'dm.message.delete',
      },
      'federation fan-out skipped — instance has FEDERATION_ENABLED=false (defence-in-depth)',
    );
    return;
  }

  const peer = await prisma.remoteInstance.findUnique({
    where: { id: input.peerInstanceId },
    select: { id: true, status: true, capabilities: true, host: true },
  });
  if (!peer) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: input.peerInstanceId,
        eventType: 'dm.message.delete',
      },
      'dm.message.delete fan-out skipped — peer RemoteInstance not found',
    );
    return;
  }
  if (peer.status !== 'peered') {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerStatus: peer.status,
        eventType: 'dm.message.delete',
      },
      'dm.message.delete fan-out skipped — peer is not peered',
    );
    return;
  }
  if (!peer.capabilities.includes('dms')) {
    input.log.warn(
      {
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        peerInstanceId: peer.id,
        peerHost: peer.host,
        peerCapabilities: peer.capabilities,
        eventType: 'dm.message.delete',
      },
      'dm.message.delete fan-out skipped — peer does not advertise the `dms` capability',
    );
    return;
  }

  const payload = dmMessageDeletePayloadSchema.parse({
    dmChannelId: input.dmChannelId,
    messageId: input.messageId,
    actorRemoteUserId: `${input.actorUsername}@${input.selfHost}`,
    deletedAt: input.deletedAt.toISOString(),
  });

  const eventType: EnvelopeEventType = 'dm.message.delete';
  try {
    await input.queues.enqueueFederationOutbox({
      messageId: input.messageId,
      peerInstanceId: input.peerInstanceId,
      eventType,
      // Delete is naturally idempotent on the receiver, but we still want a
      // fresh nonce so an edit-then-delete on the same messageId doesn't
      // dedupe against the prior edit's BullMQ job.
      nonce: ulid(),
      authorUserId: input.actorUserId,
      payload,
    });
  } catch (err: unknown) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    input.log.warn(
      {
        err: errObj,
        peerInstanceId: input.peerInstanceId,
        dmChannelId: input.dmChannelId,
        messageId: input.messageId,
        eventType,
      },
      'federation fan-out enqueue failed for peer',
    );
  }
}
