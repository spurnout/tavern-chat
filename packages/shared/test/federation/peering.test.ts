import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  CAPABILITIES,
  envelopeSchema,
  peeringRequestPayloadSchema,
  peeringAcceptPayloadSchema,
  peeringRevokePayloadSchema,
  discoveryDocSchema,
} from '../../src/federation/index.js';

describe('federation/peering schemas', () => {
  const validPayload = {
    requestedCapabilities: ['messages', 'invites'] as const,
    contactEmail: 'admin@a.example',
    note: 'Hi from A',
  };

  it('accepts a well-formed PeeringRequest payload', () => {
    expect(peeringRequestPayloadSchema.parse(validPayload)).toEqual(validPayload);
  });

  it('rejects unknown capabilities', () => {
    expect(() =>
      peeringRequestPayloadSchema.parse({ ...validPayload, requestedCapabilities: ['foo'] }),
    ).toThrow();
  });

  it('accepts a well-formed envelope', () => {
    const envelope = {
      version: PROTOCOL_VERSION,
      eventType: 'peering.request',
      nonce: '01H8XYZ7N5K3M2P8VWQX9R1B0C',
      notBefore: '2026-05-19T00:00:00Z',
      notAfter: '2026-05-19T00:05:00Z',
      fromInstance: 'a.example',
      toInstance: 'b.example',
      payload: validPayload,
      signature: 'base64-sig',
    };
    expect(envelopeSchema(peeringRequestPayloadSchema).parse(envelope)).toMatchObject({
      eventType: 'peering.request',
    });
  });

  it('rejects envelope when notAfter <= notBefore', () => {
    const env = {
      version: PROTOCOL_VERSION,
      eventType: 'peering.request',
      nonce: '01H8XYZ7N5K3M2P8VWQX9R1B0C',
      notBefore: '2026-05-19T00:05:00Z',
      notAfter: '2026-05-19T00:00:00Z',
      fromInstance: 'a.example',
      toInstance: 'b.example',
      payload: validPayload,
      signature: 'base64-sig',
    };
    expect(() => envelopeSchema(peeringRequestPayloadSchema).parse(env)).toThrow();
  });

  it('rejects an envelope with a malformed (whitespace) nonce', () => {
    const env = {
      version: PROTOCOL_VERSION,
      eventType: 'peering.request',
      nonce: 'has spaces and stuff!',
      notBefore: '2026-05-19T00:00:00Z',
      notAfter: '2026-05-19T00:05:00Z',
      fromInstance: 'a.example',
      toInstance: 'b.example',
      payload: { requestedCapabilities: ['messages'] as const },
      signature: 'base64-sig',
    };
    expect(() => envelopeSchema(peeringRequestPayloadSchema).parse(env)).toThrow();
  });

  it('accepts a well-formed discovery doc', () => {
    const doc = {
      instance: 'a.example',
      softwareVersion: 'tavern/0.0.0',
      protocolVersion: PROTOCOL_VERSION,
      instanceKey: 'ed25519:AAAA',
      endpoints: {
        peering: 'https://a.example/_federation/peering',
        events: 'wss://a.example/_federation/events',
        backfill: 'https://a.example/_federation/backfill',
      },
      capabilities: [...CAPABILITIES],
    };
    expect(discoveryDocSchema.parse(doc)).toMatchObject({ instance: 'a.example' });
  });

  it('PeeringAccept and PeeringRevoke schemas exist and are distinct', () => {
    expect(peeringAcceptPayloadSchema.parse({ acceptedCapabilities: ['messages'] })).toBeDefined();
    expect(peeringRevokePayloadSchema.parse({ reason: 'no thanks' })).toBeDefined();
  });
});
