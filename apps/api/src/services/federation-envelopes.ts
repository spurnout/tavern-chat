import { ulid } from '@tavern/shared';
import {
  PROTOCOL_VERSION,
  ENVELOPE_CLOCK_SKEW_S,
  ENVELOPE_DEFAULT_LIFETIME_S,
  envelopeSchema,
  type EnvelopeEventType,
} from '@tavern/shared';
import type { z } from 'zod';
import { canonicalize } from '../lib/canonical-json.js';
import { publicKeyFromRaw, verify as edVerify } from '../lib/ed25519.js';

export interface BuildEnvelopeInput<T> {
  eventType: EnvelopeEventType;
  fromInstance: string;
  toInstance: string;
  payload: T;
  /** Override the default 5-min window. Negative = already expired (test only). */
  lifetimeSeconds?: number;
  notBefore?: Date;
  /** Caller supplies the signing fn (so this module needn't own the keystore). */
  sign: (canonicalBytes: Buffer) => Buffer;
}

export interface SignedEnvelope<T> {
  version: typeof PROTOCOL_VERSION;
  eventType: EnvelopeEventType;
  nonce: string;
  notBefore: string;
  notAfter: string;
  fromInstance: string;
  toInstance: string;
  payload: T;
  signature: string; // base64
}

/** Canonical bytes that are actually signed — every field except `signature`. */
export function envelopeSigningBytes(env: Record<string, unknown>): Buffer {
  return Buffer.from(canonicalize(env), 'utf8');
}

export function buildSignedEnvelope<T>(input: BuildEnvelopeInput<T>): SignedEnvelope<T> {
  const now = Date.now();
  const notBefore = input.notBefore ?? new Date(now);
  const lifetime = input.lifetimeSeconds ?? ENVELOPE_DEFAULT_LIFETIME_S;
  const notAfter = new Date(notBefore.getTime() + lifetime * 1000);
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
  const signature = input.sign(envelopeSigningBytes(unsigned)).toString('base64');
  return { ...unsigned, signature };
}

export type VerifyResult<T> =
  | { ok: true; envelope: SignedEnvelope<T> }
  | { ok: false; reason: string };

export interface VerifyInput<T extends z.ZodTypeAny> {
  envelope: unknown;
  peerPublicKeyRaw: Buffer;
  payloadSchema: T;
  /** Override for tests. */
  now?: Date;
}

/**
 * Performs shape + signature + time-window validation. Does NOT log to
 * FederationEnvelopeLog — the route handler does that under transaction
 * with the replay-window unique constraint.
 */
export function verifyEnvelopeShape<T extends z.ZodTypeAny>(
  input: VerifyInput<T>,
): VerifyResult<z.infer<T>> {
  const schema = envelopeSchema(input.payloadSchema);
  const parsed = schema.safeParse(input.envelope);
  if (!parsed.success) {
    return { ok: false, reason: `envelope shape invalid: ${parsed.error.message}` };
  }
  const env = parsed.data;
  const now = input.now?.getTime() ?? Date.now();
  const skewMs = ENVELOPE_CLOCK_SKEW_S * 1000;
  const nb = Date.parse(env.notBefore);
  const na = Date.parse(env.notAfter);
  if (now + skewMs < nb) return { ok: false, reason: 'notBefore in the future' };
  if (now - skewMs > na) return { ok: false, reason: 'notAfter expired' };

  const { signature, ...unsigned } = env;
  const bytes = envelopeSigningBytes(unsigned);
  const pub = publicKeyFromRaw(input.peerPublicKeyRaw);
  const sigBytes = Buffer.from(signature, 'base64');
  if (!edVerify(bytes, sigBytes, pub)) {
    return { ok: false, reason: 'signature does not verify against peer public key' };
  }
  return { ok: true, envelope: env as SignedEnvelope<z.infer<T>> };
}
