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

export interface FanOutMessageCreateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
  channelId: string;
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
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
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

export interface FanOutMessageUpdateInput {
  queues: QueueClient;
  selfHost: string;
  serverId: string;
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
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
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
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
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
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
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
  const peerIds = await findPeersWithRemoteMembers(input.serverId);
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
