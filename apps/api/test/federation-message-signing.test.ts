import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  messageCreatePayloadSchema,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  verifyTwoLayerMessageEnvelope,
} from '../src/services/federation-message-signing.js';
import {
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSign,
} from '../src/lib/ed25519.js';

const FROM = 'a.example';
const TO = 'b.example';
const PAYLOAD = {
  authorRemoteUserId: 'alice@a.example',
  channelId: '01HXYZ',
  messageId: '01H123',
  content: 'hi',
  createdAt: '2026-05-19T00:00:00Z',
};

describe('two-layer message envelope', () => {
  it('round-trips: build then verify succeeds', () => {
    const userKp = generateKeyPair();
    const instanceKp = generateKeyPair();
    const env = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      signUser: (b) => edSign(b, userKp.privateKey),
      signInstance: (b) => edSign(b, instanceKp.privateKey),
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(instanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(userKp.publicKey),
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.messageId).toBe('01H123');
    }
  });

  it('fails when user signature is wrong', () => {
    const userKp = generateKeyPair();
    const attacker = generateKeyPair();
    const instanceKp = generateKeyPair();
    const env = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      signUser: (b) => edSign(b, attacker.privateKey), // wrong key
      signInstance: (b) => edSign(b, instanceKp.privateKey),
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(instanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(userKp.publicKey), // expects authorKp's pubkey
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('user_sig_failure');
      expect(result.reason).toMatch(/user signature/i);
    }
  });

  it('fails when instance signature is wrong', () => {
    const userKp = generateKeyPair();
    const instanceKp = generateKeyPair();
    const attacker = generateKeyPair();
    const env = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      signUser: (b) => edSign(b, userKp.privateKey),
      signInstance: (b) => edSign(b, attacker.privateKey), // wrong instance key
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(instanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(userKp.publicKey),
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('instance_sig_failure');
      expect(result.reason).toMatch(/instance signature/i);
    }
  });

  it('fails when notAfter has expired', () => {
    const userKp = generateKeyPair();
    const instanceKp = generateKeyPair();
    // notBefore 10 min ago, notAfter 5 min ago — shape-valid but expired
    const env = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: PAYLOAD,
      notBefore: new Date(Date.now() - 10 * 60 * 1000),
      lifetimeSeconds: 5 * 60,
      signUser: (b) => edSign(b, userKp.privateKey),
      signInstance: (b) => edSign(b, instanceKp.privateKey),
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(instanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(userKp.publicKey),
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('expired');
      expect(result.reason).toMatch(/expired/i);
    }
  });

  // --- P4-13 — preservedUserSignature path ---------------------------------

  it('preservedUserSignature: relayed envelope verifies under the ORIGINAL author key', () => {
    // Simulate the relay scenario: original author signs payload at home; the
    // relay-er passes that signature unchanged on a NEW envelope signed by a
    // DIFFERENT instance key. The receiver verifies user-sig under the
    // original author key and instance-sig under the relay-er's key.
    const originalUserKp = generateKeyPair();
    const originalInstanceKp = generateKeyPair(); // home instance
    const relayInstanceKp = generateKeyPair();    // the relay-er

    // Step 1: home builds the original envelope (the "inbound" envelope from
    // the relay-er's perspective).
    const originalEnv = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: FROM, // a.example — home
      toInstance: TO,     // b.example — the relay-er
      payload: PAYLOAD,
      signUser: (b) => edSign(b, originalUserKp.privateKey),
      signInstance: (b) => edSign(b, originalInstanceKp.privateKey),
    });

    // Step 2: relay-er rebuilds the envelope for peer C, preserving the
    // user signature and signing with ITS OWN instance key.
    const relayEnv = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: TO,         // b.example — the relay-er
      toInstance: 'c.example',  // forwarding to C
      payload: originalEnv.payload, // byte-equivalent payload
      preservedUserSignature: originalEnv.userSignature,
      signInstance: (b) => edSign(b, relayInstanceKp.privateKey),
    });

    // The preserved signature must be carried THROUGH unchanged.
    expect(relayEnv.userSignature).toBe(originalEnv.userSignature);

    // Peer C verifies the relay envelope with:
    //   - peerInstancePublicKeyRaw = THE RELAY-ER's instance key
    //   - authorPublicKeyRaw = original author's public key
    const result = verifyTwoLayerMessageEnvelope({
      envelope: relayEnv,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(relayInstanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(originalUserKp.publicKey),
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.messageId).toBe('01H123');
    }
  });

  it('preservedUserSignature: fails when supplied signature is invalid for the payload', () => {
    // The relay path is "garbage in, garbage out": if the upstream sig
    // doesn't actually verify against the canonical payload bytes, the
    // builder DOES NOT detect it (no verification on the build side).
    // The receiver catches it. This test pins that contract.
    const originalUserKp = generateKeyPair();
    const relayInstanceKp = generateKeyPair();

    // Make up a sig that has nothing to do with the payload.
    const bogusSig = Buffer.alloc(64, 7).toString('base64');
    const relayEnv = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: 'b.example',
      toInstance: 'c.example',
      payload: PAYLOAD,
      preservedUserSignature: bogusSig,
      signInstance: (b) => edSign(b, relayInstanceKp.privateKey),
    });
    expect(relayEnv.userSignature).toBe(bogusSig);

    const result = verifyTwoLayerMessageEnvelope({
      envelope: relayEnv,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(relayInstanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(originalUserKp.publicKey),
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('user_sig_failure');
      expect(result.reason).toMatch(/user signature/i);
    }
  });

  it('throws when both signUser and preservedUserSignature are provided', () => {
    const userKp = generateKeyPair();
    const instanceKp = generateKeyPair();
    expect(() =>
      buildTwoLayerMessageEnvelope({
        eventType: 'message.create',
        fromInstance: FROM,
        toInstance: TO,
        payload: PAYLOAD,
        signUser: (b) => edSign(b, userKp.privateKey),
        preservedUserSignature: 'AAAA',
        signInstance: (b) => edSign(b, instanceKp.privateKey),
      }),
    ).toThrow(/exactly one of signUser/i);
  });

  it('throws when neither signUser nor preservedUserSignature is provided', () => {
    const instanceKp = generateKeyPair();
    expect(() =>
      buildTwoLayerMessageEnvelope({
        eventType: 'message.create',
        fromInstance: FROM,
        toInstance: TO,
        payload: PAYLOAD,
        signInstance: (b) => edSign(b, instanceKp.privateKey),
      }),
    ).toThrow(/either signUser or preservedUserSignature/i);
  });

  it('fails when payload does not match schema', () => {
    const userKp = generateKeyPair();
    const instanceKp = generateKeyPair();
    const env = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: FROM,
      toInstance: TO,
      payload: { ...PAYLOAD, authorRemoteUserId: 'no-at-sign' } as never,
      signUser: (b) => edSign(b, userKp.privateKey),
      signInstance: (b) => edSign(b, instanceKp.privateKey),
    });
    const result = verifyTwoLayerMessageEnvelope({
      envelope: env,
      peerInstancePublicKeyRaw: exportPublicKeyRaw(instanceKp.publicKey),
      authorPublicKeyRaw: exportPublicKeyRaw(userKp.publicKey),
      payloadSchema: messageCreatePayloadSchema,
    });
    expect(result.ok).toBe(false);
  });
});
