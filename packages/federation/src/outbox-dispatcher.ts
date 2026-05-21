import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@tavern/db';
import {
  PROTOCOL_VERSION,
  ENVELOPE_DEFAULT_LIFETIME_S,
  ulid,
  type EnvelopeEventType,
} from '@tavern/shared';
import { canonicalize } from './canonical-json.js';
import { buildTwoLayerMessageEnvelope } from './federation-message-signing.js';
import type { FederationKeyStore } from './federation-keys.js';
import type { UserKeyStore } from './user-keys.js';
import { assertValidPeerHost } from './ssrf-guard.js';
import type { SingleLayerSignedEnvelope } from './sync-dispatch.js';

/**
 * One federation-outbox job: deliver a single signed event envelope to a single peer.
 * Created by the api when a federated message lands; dispatched either inline
 * (single-replica, in-memory queue) or via a BullMQ worker (multi-replica).
 */
export interface FederationOutboxJob {
  /** Local Message row id — used to load the author + payload metadata. */
  messageId: string;
  /** Target peer (RemoteInstance.id). */
  peerInstanceId: string;
  /** Envelope event type — e.g. 'message.create', 'reaction.add'. */
  eventType: EnvelopeEventType;
  /** Pre-built payload (the inner JSON the home instance and author signed over). */
  payload: unknown;
  /** Optional caller-supplied nonce — defaults to the message id so duplicate
   * enqueues get deduplicated by the BullMQ jobId. */
  nonce?: string;
  /**
   * Author's User.id — used to load the user-key signer for envelopes signed
   * by a local user. For RELAY jobs (P4-13 — home instance forwarding an
   * inbound envelope to other peers), this is still set for log/audit
   * routing, but no user-key lookup happens: the dispatcher uses
   * `preservedUserSignature` instead.
   */
  authorUserId: string;
  /**
   * P4-13 RELAY MARKER. When set, the dispatcher skips
   * `userKeys.loadKeyFor(authorUserId)` and threads this base64 string
   * straight into `buildTwoLayerMessageEnvelope` as `preservedUserSignature`.
   * The job represents "the home of T is relaying bob@b's message to peer C"
   * — we cannot re-sign on bob's behalf (we don't hold his private key), so
   * we forward his original signature unchanged and only re-sign the outer
   * envelope with this instance's key. The receiver verifies bob's signature
   * against bob's known public key from his home instance, and our envelope
   * signature against our published instance key.
   *
   * The relayed payload MUST be byte-identical to what bob originally signed
   * (same canonical bytes), otherwise his signature won't verify. The relay
   * helper (`fanOutMessageCreateRelay`) passes the original envelope's
   * payload through unchanged for that reason.
   */
  preservedUserSignature?: string;
  /**
   * P6-6 SINGLE-LAYER MARKER. When set, the dispatcher builds a single-layer
   * signed envelope (instance signature only — no user signature) instead of
   * a two-layer envelope.
   *
   * Used for envelopes that are not user-authored content events but rather
   * the home instance reporting authoritative state about its users — e.g.
   * `presence.update`. Presence is not a user-attested action: a compromised
   * user key on its own cannot fake it. We sign with the instance key only,
   * mirroring how `peering.*` envelopes are signed.
   *
   * Incompatible with `preservedUserSignature` (which is a two-layer-only
   * concept). The dispatcher throws synchronously if both are set.
   */
  singleLayer?: boolean;
}

export interface DispatcherDeps {
  prisma?: PrismaClient;
  federationKeys: FederationKeyStore;
  userKeys: UserKeyStore;
  selfHost: string;
  /** Override for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Optional structured logger. Falls back to a no-op. */
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Thrown by dispatchOutboxJob when the peer answers with a 4xx — the job
 * SHOULD NOT retry (no amount of resending fixes a malformed envelope or a
 * peer that has revoked us). The worker recognises this constructor name
 * and skips retries.
 */
export class FederationOutboxPermanentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'FederationOutboxPermanentError';
  }
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Dispatch one envelope to one peer. The full path:
 *   1. Load peer by id; skip if no longer in 'peered' state.
 *   2. Apply SSRF guard on peer.host (defence in depth — host is admin-set).
 *   3. Load author's user-key signer.
 *   4. Build two-layer envelope (user sigs payload; instance sigs the envelope).
 *   5. POST to https://<peer.host>/_federation/event with a 10s timeout.
 *   6. 2xx → success. 4xx → FederationOutboxPermanentError (do not retry).
 *      5xx / network / timeout → throw plain Error (retry-eligible).
 */
export async function dispatchOutboxJob(
  job: FederationOutboxJob,
  deps: DispatcherDeps,
): Promise<void> {
  const prisma = deps.prisma ?? defaultPrisma;
  const log = deps.logger ?? noopLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const peer = await prisma.remoteInstance.findUnique({
    where: { id: job.peerInstanceId },
  });
  if (!peer) {
    log.warn({ peerInstanceId: job.peerInstanceId, messageId: job.messageId }, 'outbox: peer not found, dropping');
    return;
  }
  if (peer.status !== 'peered') {
    log.info(
      { peerInstanceId: peer.id, host: peer.host, status: peer.status, messageId: job.messageId },
      'outbox: peer not in peered state, dropping',
    );
    return;
  }

  // Defence in depth — peer.host is admin-controlled, but a hostile DB write
  // (or future restore from a peer that was renamed) could put junk here.
  assertValidPeerHost(peer.host);

  // Three signing variants:
  //   1. Single-layer (P6-6): presence and other home-instance-asserted events.
  //      Instance signature only — no user signature is part of the wire shape.
  //   2. Relay (P4-13): the home of T is forwarding an inbound envelope to
  //      another peer. Pass the original author's signature straight through
  //      and only re-sign the outer envelope with this instance's key.
  //   3. Default two-layer: user signs the payload, instance signs the
  //      envelope. Used for all user-authored content events.
  if (job.singleLayer && job.preservedUserSignature !== undefined) {
    throw new Error(
      'dispatchOutboxJob: singleLayer and preservedUserSignature are mutually exclusive',
    );
  }
  const envelope: unknown = job.singleLayer
    ? buildSingleLayerEnvelope({
        eventType: job.eventType,
        fromInstance: deps.selfHost,
        toInstance: peer.host,
        payload: job.payload,
        signInstance: (bytes) => deps.federationKeys.sign(bytes),
      })
    : job.preservedUserSignature !== undefined
      ? buildTwoLayerMessageEnvelope({
          eventType: job.eventType,
          fromInstance: deps.selfHost,
          toInstance: peer.host,
          payload: job.payload,
          preservedUserSignature: job.preservedUserSignature,
          signInstance: (bytes) => deps.federationKeys.sign(bytes),
        })
      : await (async () => {
          const userKey = await deps.userKeys.loadKeyFor(job.authorUserId);
          return buildTwoLayerMessageEnvelope({
            eventType: job.eventType,
            fromInstance: deps.selfHost,
            toInstance: peer.host,
            payload: job.payload,
            signUser: userKey.sign,
            signInstance: (bytes) => deps.federationKeys.sign(bytes),
          });
        })();

  // Phase 3 dispatches over HTTPS even though the .well-known reserves
  // `endpoints.events` for WSS (Phase 5). Re-fetching discovery on every
  // event would be wasteful — the peer is already paired, the URL shape
  // is fixed by the protocol.
  const url = `https://${peer.host}/_federation/event`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: ac.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { peerInstanceId: peer.id, host: peer.host, messageId: job.messageId, err: msg },
      'outbox: network error',
    );
    throw new Error(`outbox dispatch network error to ${peer.host}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 200 && res.status < 300) {
    log.info(
      { peerInstanceId: peer.id, host: peer.host, messageId: job.messageId, status: res.status },
      'outbox: dispatched',
    );
    return;
  }

  const bodyText = await res.text().catch(() => '');
  const snippet = bodyText.slice(0, 200);

  if (res.status >= 400 && res.status < 500) {
    // Peer says our envelope is bad / we're not allowed / unknown route.
    // Retrying won't help. Caller (worker) should NOT requeue.
    log.error(
      { peerInstanceId: peer.id, host: peer.host, messageId: job.messageId, status: res.status, body: snippet },
      'outbox: permanent failure',
    );
    throw new FederationOutboxPermanentError(
      `outbox dispatch permanent failure to ${peer.host}: HTTP ${res.status} ${snippet}`,
      res.status,
    );
  }

  // 5xx — retry-eligible.
  log.warn(
    { peerInstanceId: peer.id, host: peer.host, messageId: job.messageId, status: res.status, body: snippet },
    'outbox: retryable failure',
  );
  throw new Error(`outbox dispatch retryable failure to ${peer.host}: HTTP ${res.status} ${snippet}`);
}

/**
 * Build a single-layer signed envelope — instance signature only. Mirrors
 * `buildSignedEnvelope` in `apps/api/src/services/federation-envelopes.ts`
 * but lives here so the dispatcher can build it without crossing the
 * package boundary.
 *
 * Used for envelopes that aren't user-authored content events. Today
 * `presence.update` (P6-6). The peering envelopes use the same wire shape
 * but go through their own synchronous send path in
 * `services/federation-peering.ts`, not the outbox queue — they don't share
 * this helper.
 */
function buildSingleLayerEnvelope<T>(input: {
  eventType: EnvelopeEventType;
  fromInstance: string;
  toInstance: string;
  payload: T;
  signInstance: (bytes: Buffer) => Buffer;
}): SingleLayerSignedEnvelope<T> {
  const now = Date.now();
  const notBefore = new Date(now);
  const notAfter = new Date(now + ENVELOPE_DEFAULT_LIFETIME_S * 1000);
  const unsigned = {
    version: PROTOCOL_VERSION,
    eventType: input.eventType,
    nonce: ulid(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fromInstance: input.fromInstance,
    toInstance: input.toInstance,
    payload: input.payload,
  } as const;
  const envelopeBytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
  const signature = input.signInstance(envelopeBytes).toString('base64');
  return { ...unsigned, signature };
}
