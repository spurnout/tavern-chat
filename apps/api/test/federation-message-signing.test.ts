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
    if (!result.ok) expect(result.reason).toMatch(/user signature/i);
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
    if (!result.ok) expect(result.reason).toMatch(/instance signature/i);
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
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
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
