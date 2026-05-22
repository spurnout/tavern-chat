/**
 * Federation Phase 4 — synchronous request/response envelope dispatch.
 *
 * Unlike `dispatchOutboxJob` (fire-and-forget delivery for fan-out events),
 * the join-request flow needs the response envelope back synchronously so
 * the receiving instance can mirror the snapshot that the home replies with.
 *
 * `postFederationEventSync`:
 *   1. SSRF-guards the peer host (defence in depth — the host is admin-
 *      pinned at peering time, but a hostile DB write could otherwise
 *      slip a 127.0.0.1 through).
 *   2. POSTs the (caller-built) envelope to `https://{peerHost}/_federation/event`
 *      with a 10s timeout default.
 *   3. On 2xx: parses the response as a SINGLE-LAYER signed envelope (the
 *      home instance signs its ack with its instance key only — there is no
 *      "user" sigil on an instance-to-instance reply), verifies the signature
 *      against the peer's instance public key, and runs the caller-supplied
 *      payload schema. Returns `{ ok: true, payload }`.
 *   4. On 4xx/5xx: returns `{ ok: false, status, reason }` with a trimmed
 *      snippet of the response body. The CALLER decides whether the error
 *      is retryable — the helper itself does not retry.
 *
 * Why a single helper instead of two (sync-two-layer-out + sync-one-layer-back):
 * the two-layer outgoing envelope is built by the CALLER and passed in; this
 * helper only does the POST + response verification. Layering choices on the
 * way OUT are the caller's responsibility (member.join_request happens to be
 * two-layer; channel.create might be single-layer; the helper doesn't care).
 * What it standardises is the on-the-wire shape of the REPLY — a single-layer
 * signed envelope. Phase 7 (when we introduce moderator-signed replies) can
 * add a second helper or extend this one with a `responseLayer` switch.
 */

import { z } from 'zod';
import { canonicalize } from './canonical-json.js';
import { publicKeyFromRaw, verify as edVerify } from './ed25519.js';
import { assertValidPeerHost } from './ssrf-guard.js';
import type { TwoLayerSignedEnvelope } from './federation-message-signing.js';
import {
  PROTOCOL_VERSION,
  ENVELOPE_CLOCK_SKEW_S,
  ENVELOPE_EVENT_TYPES,
  type EnvelopeEventType,
} from '@tavern/shared';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Single-layer signed envelope wire shape — the response side of the sync
 * dispatch. Mirrors the type defined in `apps/api/src/services/federation-
 * envelopes.ts` but lives here so the federation package can verify replies
 * without crossing the app boundary.
 */
export interface SingleLayerSignedEnvelope<T> {
  version: typeof PROTOCOL_VERSION;
  eventType: EnvelopeEventType;
  nonce: string;
  notBefore: string;
  notAfter: string;
  fromInstance: string;
  toInstance: string;
  payload: T;
  signature: string;
}

export interface PostFederationEventSyncInput<TPayload> {
  /** Peer hostname, e.g. `a.example`. */
  peerHost: string;
  /**
   * Caller-built outgoing envelope. The helper does not care whether it is
   * single- or two-layer; it just serialises and POSTs as JSON. Typed
   * loosely so member.join_request (two-layer) and any future single-layer
   * sync request both flow through the same helper.
   */
  envelope: TwoLayerSignedEnvelope<unknown> | SingleLayerSignedEnvelope<unknown>;
  /** Zod schema for the EXPECTED payload inside the response envelope. */
  expectedPayloadSchema: z.ZodSchema<TPayload>;
  /** Peer instance's published ed25519 public key (32 raw bytes). */
  peerPublicKeyRaw: Buffer;
  /** This instance's host — required for the response `toInstance` check. */
  selfHost: string;
  /** Override the 10s default. */
  timeoutMs?: number;
  /** Override fetch impl (used by tests). */
  fetchImpl?: typeof fetch;
  /** Override the URL path (defaults to `/_federation/event`). */
  pathOverride?: string;
}

export type PostFederationEventSyncResult<TPayload> =
  | { ok: true; payload: TPayload }
  | { ok: false; status: number; reason: string };

/**
 * Signature alias so callers (and test fixtures that swap the implementation)
 * can spell the function's type without re-declaring the input/result shapes.
 */
export type PostFederationEventSyncFn = <TPayload>(
  input: PostFederationEventSyncInput<TPayload>,
) => Promise<PostFederationEventSyncResult<TPayload>>;

/**
 * POST a signed envelope to a peer's `/_federation/event` and verify the
 * single-layer signed envelope it replies with. See the module-level docblock
 * for the full contract.
 */
export async function postFederationEventSync<TPayload>(
  input: PostFederationEventSyncInput<TPayload>,
): Promise<PostFederationEventSyncResult<TPayload>> {
  await assertValidPeerHost(input.peerHost);

  const url = `https://${input.peerHost}${input.pathOverride ?? '/_federation/event'}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.envelope),
      signal: ac.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, reason: `network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }

  if (res.status < 200 || res.status >= 300) {
    const bodyText = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      reason: bodyText.slice(0, 200) || `HTTP ${res.status}`,
    };
  }

  // 2xx — parse + verify the response envelope.
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: res.status, reason: `response is not JSON: ${msg}` };
  }

  const wireSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    eventType: z.enum(ENVELOPE_EVENT_TYPES),
    nonce: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/),
    notBefore: z.string().datetime({ offset: true }),
    notAfter: z.string().datetime({ offset: true }),
    fromInstance: z.string().min(1).max(253),
    toInstance: z.string().min(1).max(253),
    payload: input.expectedPayloadSchema,
    signature: z.string().min(1),
  });

  const parsed = wireSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: res.status,
      reason: `response envelope shape invalid: ${parsed.error.message}`,
    };
  }
  const env = parsed.data;

  // Sanity: the home replied to US — toInstance must match selfHost.
  if (env.toInstance !== input.selfHost) {
    return {
      ok: false,
      status: res.status,
      reason: `response toInstance ${env.toInstance} does not match selfHost ${input.selfHost}`,
    };
  }
  // And from the host we POSTed to.
  if (env.fromInstance !== input.peerHost) {
    return {
      ok: false,
      status: res.status,
      reason: `response fromInstance ${env.fromInstance} does not match peerHost ${input.peerHost}`,
    };
  }

  // Time-window check — replicates verifyEnvelopeShape in
  // apps/api/src/services/federation-envelopes.ts so a stale reply gets
  // rejected here rather than re-checked downstream.
  if (Date.parse(env.notAfter) <= Date.parse(env.notBefore)) {
    return { ok: false, status: res.status, reason: 'notAfter must be after notBefore' };
  }
  const now = Date.now();
  const skewMs = ENVELOPE_CLOCK_SKEW_S * 1000;
  if (now + skewMs < Date.parse(env.notBefore)) {
    return { ok: false, status: res.status, reason: 'response notBefore in the future' };
  }
  if (now - skewMs > Date.parse(env.notAfter)) {
    return { ok: false, status: res.status, reason: 'response notAfter expired' };
  }

  // Signature check.
  const { signature, ...unsigned } = env;
  const envelopeBytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
  const sigBytes = Buffer.from(signature, 'base64');
  const peerPub = publicKeyFromRaw(input.peerPublicKeyRaw);
  if (!edVerify(envelopeBytes, sigBytes, peerPub)) {
    return {
      ok: false,
      status: res.status,
      reason: 'response signature does not verify against peer public key',
    };
  }

  return { ok: true, payload: env.payload as TPayload };
}
