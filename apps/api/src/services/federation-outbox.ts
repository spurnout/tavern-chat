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
import { messageCreatePayloadSchema } from '@tavern/shared';
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
