/**
 * Characterization tests for the two-layer signed envelope:
 * `buildTwoLayerMessageEnvelope` and `verifyTwoLayerMessageEnvelope`.
 *
 * Coverage targets:
 *  - build: the exactly-one-of {signUser, preservedUserSignature} invariant
 *    (both → throw, neither → throw), the signUser path, and the
 *    preservedUserSignature relay path.
 *  - verify: a happy-path round-trip, plus every failure discriminator —
 *    envelope_invalid (bad shape / unknown event type / notAfter<=notBefore),
 *    expired (notBefore future, notAfter past), user_sig_failure (tampered
 *    payload, wrong author key), and instance_sig_failure (tampered instance
 *    signature, wrong peer key).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  generateKeyPair,
  sign as edSign,
  exportPublicKeyRaw,
} from './ed25519.js';
import {
  buildTwoLayerMessageEnvelope,
  verifyTwoLayerMessageEnvelope,
  type TwoLayerSignedEnvelope,
} from './federation-message-signing.js';
import { PROTOCOL_VERSION } from '@tavern/shared';

const FROM = 'home.example';
const TO = 'peer.example';

const payloadSchema = z.object({ messageId: z.string(), body: z.string() });
type Payload = z.infer<typeof payloadSchema>;
const samplePayload: Payload = { messageId: 'msg-1', body: 'hello tavern' };

/** Author (user) and instance keypairs for a "home" instance. */
function makeKeys() {
  const userKp = generateKeyPair();
  const instanceKp = generateKeyPair();
  return {
    userKp,
    instanceKp,
    authorPublicKeyRaw: exportPublicKeyRaw(userKp.publicKey),
    instancePublicKeyRaw: exportPublicKeyRaw(instanceKp.publicKey),
    signUser: (bytes: Buffer) => edSign(bytes, userKp.privateKey),
    signInstance: (bytes: Buffer) => edSign(bytes, instanceKp.privateKey),
  };
}

function buildEnvelope(
  keys: ReturnType<typeof makeKeys>,
  overrides: Partial<Parameters<typeof buildTwoLayerMessageEnvelope<Payload>>[0]> = {},
): TwoLayerSignedEnvelope<Payload> {
  return buildTwoLayerMessageEnvelope<Payload>({
    eventType: 'message.create',
    fromInstance: FROM,
    toInstance: TO,
    payload: samplePayload,
    signUser: keys.signUser,
    signInstance: keys.signInstance,
    ...overrides,
  });
}

describe('buildTwoLayerMessageEnvelope', () => {
  it('builds a structurally complete envelope with both signatures', () => {
    const keys = makeKeys();
    const env = buildEnvelope(keys);
    expect(env.version).toBe(PROTOCOL_VERSION);
    expect(env.eventType).toBe('message.create');
    expect(env.fromInstance).toBe(FROM);
    expect(env.toInstance).toBe(TO);
    expect(env.payload).toEqual(samplePayload);
    expect(typeof env.nonce).toBe('string');
    expect(env.userSignature.length).toBeGreaterThan(0);
    expect(env.signature.length).toBeGreaterThan(0);
    // notAfter strictly after notBefore.
    expect(Date.parse(env.notAfter)).toBeGreaterThan(Date.parse(env.notBefore));
  });

  it('throws when BOTH signUser and preservedUserSignature are supplied', () => {
    const keys = makeKeys();
    expect(() =>
      buildEnvelope(keys, { preservedUserSignature: 'AAAA' }),
    ).toThrow(/exactly one of signUser \/ preservedUserSignature/i);
  });

  it('throws when NEITHER signUser nor preservedUserSignature is supplied', () => {
    const keys = makeKeys();
    expect(() =>
      buildTwoLayerMessageEnvelope<Payload>({
        eventType: 'message.create',
        fromInstance: FROM,
        toInstance: TO,
        payload: samplePayload,
        signInstance: keys.signInstance,
        // no signUser, no preservedUserSignature
      }),
    ).toThrow(/must provide either signUser or preservedUserSignature/i);
  });

  it('reuses a preserved user signature verbatim (relay path)', () => {
    const keys = makeKeys();
    // Produce a valid user signature the "normal" way first.
    const signed = buildEnvelope(keys);
    const preserved = signed.userSignature;

    const relayed = buildTwoLayerMessageEnvelope<Payload>({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: samplePayload,
      preservedUserSignature: preserved,
      signInstance: keys.signInstance,
    });
    expect(relayed.userSignature).toBe(preserved);
  });

  it('honours a caller-supplied notBefore and lifetimeSeconds', () => {
    const keys = makeKeys();
    const notBefore = new Date('2030-01-01T00:00:00.000Z');
    const env = buildEnvelope(keys, { notBefore, lifetimeSeconds: 120 });
    expect(env.notBefore).toBe(notBefore.toISOString());
    expect(env.notAfter).toBe(
      new Date(notBefore.getTime() + 120 * 1000).toISOString(),
    );
  });
});

describe('verifyTwoLayerMessageEnvelope — happy path', () => {
  it('verifies a freshly built envelope (round-trip)', () => {
    const keys = makeKeys();
    const env = buildEnvelope(keys);
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(samplePayload);
      expect(result.envelope.signature).toBe(env.signature);
    }
  });

  it('verifies the relay-path envelope (preserved user signature)', () => {
    const keys = makeKeys();
    const signed = buildEnvelope(keys);
    const relayed = buildTwoLayerMessageEnvelope<Payload>({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: samplePayload,
      preservedUserSignature: signed.userSignature,
      signInstance: keys.signInstance,
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: relayed,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyTwoLayerMessageEnvelope — envelope_invalid', () => {
  it('rejects a non-object / null envelope', () => {
    const keys = makeKeys();
    const result = verifyTwoLayerMessageEnvelope({
      envelope: null,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('envelope_invalid');
  });

  it('rejects an envelope with the wrong protocol version', () => {
    const keys = makeKeys();
    const env = { ...buildEnvelope(keys), version: 'wrong/9' };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('envelope_invalid');
  });

  it('rejects an unknown event type', () => {
    const keys = makeKeys();
    const env = { ...buildEnvelope(keys), eventType: 'totally.bogus' };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('envelope_invalid');
  });

  it('rejects when the payload fails its schema', () => {
    const keys = makeKeys();
    // Build with a payload that does not match the strict verify schema.
    const env = buildTwoLayerMessageEnvelope<unknown>({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: { messageId: 'msg-1' /* missing body */ },
      signUser: keys.signUser,
      signInstance: keys.signInstance,
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('envelope_invalid');
  });

  it('rejects a missing instance signature (empty string fails min(1))', () => {
    const keys = makeKeys();
    const env = { ...buildEnvelope(keys), signature: '' };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('envelope_invalid');
  });

  it('rejects when notAfter is not strictly after notBefore', () => {
    const keys = makeKeys();
    const ts = new Date().toISOString();
    // Equal timestamps pass the datetime schema but fail the explicit check.
    const env = { ...buildEnvelope(keys), notBefore: ts, notAfter: ts };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('envelope_invalid');
      expect(result.reason).toMatch(/notAfter must be after notBefore/i);
    }
  });
});

describe('verifyTwoLayerMessageEnvelope — expired', () => {
  it('rejects when notBefore is in the future (beyond clock skew)', () => {
    const keys = makeKeys();
    const notBefore = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const env = buildEnvelope(keys, { notBefore, lifetimeSeconds: 300 });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('expired');
      expect(result.reason).toMatch(/notBefore in the future/i);
    }
  });

  it('rejects when notAfter is in the past (beyond clock skew)', () => {
    const keys = makeKeys();
    const notBefore = new Date(Date.now() - 60 * 60 * 1000); // -1h
    const env = buildEnvelope(keys, { notBefore, lifetimeSeconds: 300 });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('expired');
      expect(result.reason).toMatch(/notAfter expired/i);
    }
  });

  it('honours an injected `now` (envelope valid at its own time window)', () => {
    const keys = makeKeys();
    const notBefore = new Date('2031-06-01T00:00:00.000Z');
    const env = buildEnvelope(keys, { notBefore, lifetimeSeconds: 300 });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
      now: new Date('2031-06-01T00:01:00.000Z'),
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyTwoLayerMessageEnvelope — user_sig_failure', () => {
  it('rejects when the payload was tampered after signing', () => {
    const keys = makeKeys();
    const env = buildEnvelope(keys);
    // Mutate the payload so the user signature no longer matches; instance
    // signature also breaks, but the user check runs first.
    const tampered = {
      ...env,
      payload: { messageId: 'msg-1', body: 'tampered body' },
    };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: tampered,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('user_sig_failure');
      expect(result.reason).toMatch(/user signature does not verify/i);
    }
  });

  it('rejects when verified against the WRONG author key', () => {
    const keys = makeKeys();
    const env = buildEnvelope(keys);
    const stranger = generateKeyPair();
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: exportPublicKeyRaw(stranger.publicKey),
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('user_sig_failure');
  });

  it('rejects when the user signature is replaced with garbage base64', () => {
    const keys = makeKeys();
    const env = { ...buildEnvelope(keys), userSignature: 'Zm9vYmFy' };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('user_sig_failure');
  });
});

describe('verifyTwoLayerMessageEnvelope — instance_sig_failure', () => {
  it('rejects when the instance signature is signed by a different key', () => {
    // User signs correctly, but a different instance key signs the envelope.
    const keys = makeKeys();
    const attackerInstance = generateKeyPair();
    const env = buildTwoLayerMessageEnvelope<Payload>({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: samplePayload,
      signUser: keys.signUser,
      signInstance: (bytes) => edSign(bytes, attackerInstance.privateKey),
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      // verify against the LEGITIMATE peer key, which won't match.
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('instance_sig_failure');
      expect(result.reason).toMatch(/instance signature does not verify/i);
    }
  });

  it('rejects when verified against the WRONG peer instance key', () => {
    const keys = makeKeys();
    const env = buildEnvelope(keys);
    const otherPeer = generateKeyPair();
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(otherPeer.publicKey),
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('instance_sig_failure');
  });

  it('rejects when an envelope field (toInstance) is tampered post-signing', () => {
    // User sig still verifies (payload unchanged), but the instance sig covers
    // toInstance, so flipping it breaks the instance layer specifically.
    const keys = makeKeys();
    const env = { ...buildEnvelope(keys), toInstance: 'evil.example' };
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: keys.instancePublicKeyRaw,
      authorPublicKeyRaw: keys.authorPublicKeyRaw,
      payloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('instance_sig_failure');
  });
});
