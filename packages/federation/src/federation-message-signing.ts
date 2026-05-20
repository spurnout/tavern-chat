import { ulid } from '@tavern/shared';
import {
  PROTOCOL_VERSION,
  ENVELOPE_CLOCK_SKEW_S,
  ENVELOPE_DEFAULT_LIFETIME_S,
  type EnvelopeEventType,
} from '@tavern/shared';
import { z } from 'zod';
import { canonicalize } from './canonical-json.js';
import { publicKeyFromRaw, verify as edVerify } from './ed25519.js';

/**
 * Two-layer signed envelope. Carries BOTH a user signature (proves action authorship)
 * AND an instance signature (proves the home instance still vouches for the user).
 *
 * Wire shape extends the single-layer envelope from federation-envelopes.ts with
 * an extra `userSignature` field. The top-level `signature` IS the instance signature;
 * naming kept for backward compat with the Phase 1 envelope shape.
 */
export interface TwoLayerSignedEnvelope<T> {
  version: typeof PROTOCOL_VERSION;
  eventType: EnvelopeEventType;
  nonce: string;
  notBefore: string;
  notAfter: string;
  fromInstance: string;
  toInstance: string;
  payload: T;
  userSignature: string; // base64 — user-key signature over canonical(payload)
  signature: string; // base64 — instance-key signature over canonical(envelope w/o instance signature)
}

export interface BuildTwoLayerInput<T> {
  eventType: EnvelopeEventType;
  fromInstance: string;
  toInstance: string;
  payload: T;
  lifetimeSeconds?: number;
  notBefore?: Date;
  /** Caller-supplied user signer (typically userKeys.loadKeyFor(userId).sign) */
  signUser: (canonicalPayloadBytes: Buffer) => Buffer;
  /** Caller-supplied instance signer (typically federationKeys.sign) */
  signInstance: (canonicalEnvelopeBytes: Buffer) => Buffer;
}

export function buildTwoLayerMessageEnvelope<T>(
  input: BuildTwoLayerInput<T>,
): TwoLayerSignedEnvelope<T> {
  const now = Date.now();
  const notBefore = input.notBefore ?? new Date(now);
  const lifetime = input.lifetimeSeconds ?? ENVELOPE_DEFAULT_LIFETIME_S;
  const notAfter = new Date(notBefore.getTime() + lifetime * 1000);

  // Layer 1: user signs canonical(payload)
  const payloadBytes = Buffer.from(canonicalize(input.payload as unknown), 'utf8');
  const userSignature = input.signUser(payloadBytes).toString('base64');

  // Layer 2: instance signs canonical(envelope-minus-instance-signature),
  // which DOES include userSignature so a peer can't strip it.
  const unsigned = {
    version: PROTOCOL_VERSION,
    eventType: input.eventType,
    nonce: ulid(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fromInstance: input.fromInstance,
    toInstance: input.toInstance,
    payload: input.payload,
    userSignature,
  } as const;
  const envelopeBytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
  const signature = input.signInstance(envelopeBytes).toString('base64');

  return { ...unsigned, signature };
}

export type TwoLayerVerifyResult<T> =
  | { ok: true; envelope: TwoLayerSignedEnvelope<T>; payload: T }
  | { ok: false; reason: string };

export interface TwoLayerVerifyInput<T extends z.ZodTypeAny> {
  envelope: unknown;
  /** Peer instance's published ed25519 public key (32 raw bytes) */
  peerInstancePublicKeyRaw: Buffer;
  /** Author's ed25519 public key from their home instance's profile (32 raw bytes) */
  authorPublicKeyRaw: Buffer;
  payloadSchema: T;
  now?: Date;
}

export function verifyTwoLayerMessageEnvelope<T extends z.ZodTypeAny>(
  input: TwoLayerVerifyInput<T>,
): TwoLayerVerifyResult<z.infer<T>> {
  const wireSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    eventType: z.string(),
    nonce: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/),
    notBefore: z.string().datetime({ offset: true }),
    notAfter: z.string().datetime({ offset: true }),
    fromInstance: z.string().min(1).max(253),
    toInstance: z.string().min(1).max(253),
    payload: input.payloadSchema,
    userSignature: z.string().min(1),
    signature: z.string().min(1),
  });

  const parsed = wireSchema.safeParse(input.envelope);
  if (!parsed.success) {
    return { ok: false, reason: `envelope shape invalid: ${parsed.error.message}` };
  }

  const env = parsed.data;

  // Replicate the superRefine check from envelopeSchema
  if (Date.parse(env.notAfter) <= Date.parse(env.notBefore)) {
    return { ok: false, reason: 'notAfter must be after notBefore' };
  }

  const now = input.now?.getTime() ?? Date.now();
  const skewMs = ENVELOPE_CLOCK_SKEW_S * 1000;
  const nb = Date.parse(env.notBefore);
  const na = Date.parse(env.notAfter);
  if (now + skewMs < nb) return { ok: false, reason: 'notBefore in the future' };
  if (now - skewMs > na) return { ok: false, reason: 'notAfter expired' };

  // Verify USER signature over canonical(payload)
  const payloadBytes = Buffer.from(canonicalize(env.payload as unknown), 'utf8');
  const userSigBytes = Buffer.from(env.userSignature, 'base64');
  const authorPub = publicKeyFromRaw(input.authorPublicKeyRaw);
  if (!edVerify(payloadBytes, userSigBytes, authorPub)) {
    return { ok: false, reason: 'user signature does not verify against author public key' };
  }

  // Verify INSTANCE signature over canonical(envelope-minus-instance-signature)
  const { signature, ...unsigned } = env;
  const envelopeBytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
  const instanceSigBytes = Buffer.from(signature, 'base64');
  const instancePub = publicKeyFromRaw(input.peerInstancePublicKeyRaw);
  if (!edVerify(envelopeBytes, instanceSigBytes, instancePub)) {
    return { ok: false, reason: 'instance signature does not verify against peer public key' };
  }

  return { ok: true, envelope: env as TwoLayerSignedEnvelope<z.infer<T>>, payload: env.payload };
}
