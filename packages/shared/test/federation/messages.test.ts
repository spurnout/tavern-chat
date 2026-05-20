import { describe, it, expect } from 'vitest';
import {
  messageCreatePayloadSchema,
  messageUpdatePayloadSchema,
  messageDeletePayloadSchema,
  reactionAddPayloadSchema,
  reactionRemovePayloadSchema,
  envelopeSchema,
  PROTOCOL_VERSION,
  ENVELOPE_EVENT_TYPES,
} from '../../src/federation/index.js';

describe('federation/messages schemas', () => {
  it('accepts a well-formed message.create payload', () => {
    const p = {
      authorRemoteUserId: 'alice@b.example',
      channelId: '01HXYZ',
      messageId: '01H123',
      content: 'hello',
      createdAt: '2026-05-19T00:00:00Z',
    };
    expect(messageCreatePayloadSchema.parse(p)).toMatchObject({ messageId: '01H123' });
  });

  it('rejects message.create with bad authorRemoteUserId', () => {
    expect(() => messageCreatePayloadSchema.parse({
      authorRemoteUserId: 'no-at-sign',
      channelId: '01HX',
      messageId: '01H1',
      content: 'x',
      createdAt: '2026-05-19T00:00:00Z',
    })).toThrow();
  });

  it('rejects message.create with content too long', () => {
    expect(() => messageCreatePayloadSchema.parse({
      authorRemoteUserId: 'alice@b.example',
      channelId: '01HX',
      messageId: '01H1',
      content: 'x'.repeat(9000),
      createdAt: '2026-05-19T00:00:00Z',
    })).toThrow();
  });

  it('accepts message.update with editedAt', () => {
    expect(messageUpdatePayloadSchema.parse({
      authorRemoteUserId: 'alice@b.example',
      messageId: '01H1',
      content: 'edited',
      editedAt: '2026-05-19T00:01:00Z',
    })).toBeDefined();
  });

  it('accepts message.delete', () => {
    expect(messageDeletePayloadSchema.parse({
      actorRemoteUserId: 'alice@b.example',
      messageId: '01H1',
      deletedAt: '2026-05-19T00:01:00Z',
    })).toBeDefined();
  });

  it('accepts reaction.add and reaction.remove', () => {
    const p = { actorRemoteUserId: 'alice@b.example', messageId: '01H1', emoji: '😀' };
    expect(reactionAddPayloadSchema.parse(p)).toBeDefined();
    expect(reactionRemovePayloadSchema.parse(p)).toBeDefined();
  });

  it('ENVELOPE_EVENT_TYPES includes the 5 new types', () => {
    for (const t of ['message.create', 'message.update', 'message.delete', 'reaction.add', 'reaction.remove']) {
      expect(ENVELOPE_EVENT_TYPES).toContain(t);
    }
  });

  it('wraps message.create cleanly in an envelope', () => {
    const env = {
      version: PROTOCOL_VERSION,
      eventType: 'message.create',
      nonce: '01H8XYZ7N5K3M2P8VWQX9R1B0C',
      notBefore: '2026-05-19T00:00:00Z',
      notAfter: '2026-05-19T00:05:00Z',
      fromInstance: 'a.example',
      toInstance: 'b.example',
      payload: {
        authorRemoteUserId: 'alice@a.example',
        channelId: '01HX',
        messageId: '01H1',
        content: 'hi',
        createdAt: '2026-05-19T00:00:00Z',
      },
      signature: 'sig',
    };
    expect(envelopeSchema(messageCreatePayloadSchema).parse(env)).toMatchObject({
      eventType: 'message.create',
    });
  });
});
