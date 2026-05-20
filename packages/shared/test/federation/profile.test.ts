import { describe, it, expect } from 'vitest';
import {
  profileRequestPayloadSchema,
  profileResponsePayloadSchema,
  envelopeSchema,
  PROTOCOL_VERSION,
} from '../../src/federation/index.js';

describe('federation/profile schemas', () => {
  it('accepts a well-formed profile.request payload', () => {
    expect(profileRequestPayloadSchema.parse({ localpart: 'alice' })).toEqual({ localpart: 'alice' });
  });

  it('rejects an empty localpart', () => {
    expect(() => profileRequestPayloadSchema.parse({ localpart: '' })).toThrow();
  });

  it('rejects a localpart with invalid characters', () => {
    expect(() => profileRequestPayloadSchema.parse({ localpart: 'alice@b.com' })).toThrow();
    expect(() => profileRequestPayloadSchema.parse({ localpart: 'has space' })).toThrow();
  });

  it('accepts a well-formed profile.response payload', () => {
    const r = profileResponsePayloadSchema.parse({
      remoteUserId: 'alice@b.example',
      displayName: 'Alice',
      avatarUrl: 'https://b.example/avatar.png',
      publicKey: 'ed25519:AAAA',
    });
    expect(r.remoteUserId).toBe('alice@b.example');
  });

  it('rejects a malformed publicKey', () => {
    expect(() => profileResponsePayloadSchema.parse({
      remoteUserId: 'alice@b.example',
      displayName: 'Alice',
      publicKey: 'not-ed25519',
    })).toThrow();
  });

  it('wraps cleanly in an envelope', () => {
    const envelope = {
      version: PROTOCOL_VERSION,
      eventType: 'profile.request',
      nonce: '01H8XYZ7N5K3M2P8VWQX9R1B0C',
      notBefore: '2026-05-19T00:00:00Z',
      notAfter: '2026-05-19T00:05:00Z',
      fromInstance: 'a.example',
      toInstance: 'b.example',
      payload: { localpart: 'alice' },
      signature: 'sig',
    };
    expect(envelopeSchema(profileRequestPayloadSchema).parse(envelope)).toMatchObject({
      eventType: 'profile.request',
    });
  });
});
