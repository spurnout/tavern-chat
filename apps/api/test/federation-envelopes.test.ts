import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  ENVELOPE_CLOCK_SKEW_S,
  peeringRequestPayloadSchema,
} from '@tavern/shared';
import {
  buildSignedEnvelope,
  verifyEnvelopeShape,
} from '../src/services/federation-envelopes.js';
import {
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSignFn,
} from '../src/lib/ed25519.js';

const FROM = 'a.example';
const TO = 'b.example';
const PAYLOAD = { requestedCapabilities: ['messages'] as const };

describe('federation envelopes', () => {
  it('builds an envelope that verifies under the matching public key', () => {
    const kp = generateKeyPair();
    const env = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      sign: (bytes) => edSignFn(bytes, kp.privateKey),
    });
    const pubRaw = exportPublicKeyRaw(kp.publicKey);
    const result = verifyEnvelopeShape({
      envelope: env,
      peerPublicKeyRaw: pubRaw,
      payloadSchema: peeringRequestPayloadSchema,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an envelope signed by the wrong key', () => {
    const signer = generateKeyPair();
    const attacker = generateKeyPair();
    const env = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      sign: (bytes) => edSignFn(bytes, signer.privateKey),
    });
    const result = verifyEnvelopeShape({
      envelope: env,
      peerPublicKeyRaw: exportPublicKeyRaw(attacker.publicKey),
      payloadSchema: peeringRequestPayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sig_failure');
      expect(result.reason).toMatch(/signature/i);
    }
  });

  it('rejects an envelope where notAfter <= notBefore (shape-level)', () => {
    const kp = generateKeyPair();
    const env = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      lifetimeSeconds: -1,
      sign: (bytes) => edSignFn(bytes, kp.privateKey),
    });
    const result = verifyEnvelopeShape({
      envelope: env,
      peerPublicKeyRaw: exportPublicKeyRaw(kp.publicKey),
      payloadSchema: peeringRequestPayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('envelope_invalid');
      expect(result.reason).toMatch(/expired|notAfter/i);
    }
  });

  it('rejects an envelope whose window has already closed', () => {
    const kp = generateKeyPair();
    // notBefore = 10 min ago, notAfter = 5 min ago — shape-valid
    // (notAfter > notBefore), but the window closed 5 minutes ago.
    const notBefore = new Date(Date.now() - 10 * 60 * 1000);
    const env = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      notBefore,
      lifetimeSeconds: 5 * 60, // notAfter = notBefore + 5 min = 5 min ago
      sign: (bytes) => edSignFn(bytes, kp.privateKey),
    });
    const result = verifyEnvelopeShape({
      envelope: env,
      peerPublicKeyRaw: exportPublicKeyRaw(kp.publicKey),
      payloadSchema: peeringRequestPayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('expired');
      expect(result.reason).toMatch(/expired/i);
    }
  });

  it('tolerates clock skew up to ENVELOPE_CLOCK_SKEW_S', () => {
    const kp = generateKeyPair();
    const env = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      notBefore: new Date(Date.now() + 1000 * (ENVELOPE_CLOCK_SKEW_S / 2)),
      sign: (bytes) => edSignFn(bytes, kp.privateKey),
    });
    const result = verifyEnvelopeShape({
      envelope: env,
      peerPublicKeyRaw: exportPublicKeyRaw(kp.publicKey),
      payloadSchema: peeringRequestPayloadSchema,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects payload that does not match the schema', () => {
    const kp = generateKeyPair();
    const env = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: FROM,
      toInstance: TO,
      payload: { requestedCapabilities: ['notreal'] } as never,
      sign: (bytes) => edSignFn(bytes, kp.privateKey),
    });
    const result = verifyEnvelopeShape({
      envelope: env,
      peerPublicKeyRaw: exportPublicKeyRaw(kp.publicKey),
      payloadSchema: peeringRequestPayloadSchema,
    });
    expect(result.ok).toBe(false);
  });
});
