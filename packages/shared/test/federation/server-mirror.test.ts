import { describe, it, expect } from 'vitest';
import {
  serverUpdatePayloadSchema,
  channelCreatePayloadSchema,
  channelUpdatePayloadSchema,
  channelDeletePayloadSchema,
  ENVELOPE_EVENT_TYPES,
} from '../../src/federation/index.js';

// Valid ULIDs (Crockford base32, 26 chars)
const SERVER_ID = '01HXYZ7N5K3M2P8VWQX9R1B0C0';
const CHANNEL_ID = '01HXYZ7N5K3M2P8VWQX9R1B0C1';

describe('federation/server-mirror schemas', () => {
  describe('serverUpdatePayloadSchema', () => {
    it('accepts a payload with only the required serverId', () => {
      expect(serverUpdatePayloadSchema.parse({ serverId: SERVER_ID })).toEqual({
        serverId: SERVER_ID,
      });
    });

    it('accepts a payload with all optional fields set', () => {
      const p = {
        serverId: SERVER_ID,
        name: 'Renamed Tavern',
        description: 'New description',
        iconUrl: 'https://a.example/new-icon.png',
      };
      expect(serverUpdatePayloadSchema.parse(p)).toEqual(p);
    });

    it('accepts null description and iconUrl', () => {
      expect(
        serverUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          description: null,
          iconUrl: null,
        }),
      ).toBeDefined();
    });

    it('rejects missing serverId', () => {
      expect(() => serverUpdatePayloadSchema.parse({ name: 'X' })).toThrow();
    });

    it('rejects name exceeding max length', () => {
      expect(() =>
        serverUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          name: 'x'.repeat(65),
        }),
      ).toThrow();
    });

    it('rejects empty name', () => {
      expect(() =>
        serverUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          name: '',
        }),
      ).toThrow();
    });

    it('rejects description exceeding max length', () => {
      expect(() =>
        serverUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          description: 'x'.repeat(2049),
        }),
      ).toThrow();
    });

    it('rejects iconUrl that is not a URL', () => {
      expect(() =>
        serverUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          iconUrl: 'not-a-url',
        }),
      ).toThrow();
    });
  });

  describe('channelCreatePayloadSchema', () => {
    const baseChannel = {
      id: CHANNEL_ID,
      name: 'general',
      type: 'text' as const,
      topic: null,
      position: 0,
    };

    it('accepts a payload with defaults applied (federationMode -> inherit, nsfw -> false)', () => {
      const result = channelCreatePayloadSchema.parse({
        serverId: SERVER_ID,
        channel: baseChannel,
      });
      expect(result.channel.federationMode).toBe('inherit');
      expect(result.channel.nsfw).toBe(false);
    });

    it('accepts a payload with all fields explicit', () => {
      const result = channelCreatePayloadSchema.parse({
        serverId: SERVER_ID,
        channel: {
          ...baseChannel,
          topic: 'Welcome!',
          federationMode: 'force_on',
          nsfw: true,
        },
      });
      expect(result.channel.federationMode).toBe('force_on');
      expect(result.channel.nsfw).toBe(true);
    });

    it('accepts a forum-type channel', () => {
      expect(
        channelCreatePayloadSchema.parse({
          serverId: SERVER_ID,
          channel: { ...baseChannel, type: 'forum' },
        }),
      ).toBeDefined();
    });

    it('rejects missing channel field', () => {
      expect(() =>
        channelCreatePayloadSchema.parse({ serverId: SERVER_ID }),
      ).toThrow();
    });

    it('rejects bad channel type enum', () => {
      expect(() =>
        channelCreatePayloadSchema.parse({
          serverId: SERVER_ID,
          channel: { ...baseChannel, type: 'voice' },
        }),
      ).toThrow();
    });

    it('rejects bad federationMode enum', () => {
      expect(() =>
        channelCreatePayloadSchema.parse({
          serverId: SERVER_ID,
          channel: { ...baseChannel, federationMode: 'always_off' },
        }),
      ).toThrow();
    });

    it('rejects channel name exceeding max length', () => {
      expect(() =>
        channelCreatePayloadSchema.parse({
          serverId: SERVER_ID,
          channel: { ...baseChannel, name: 'x'.repeat(65) },
        }),
      ).toThrow();
    });

    it('rejects negative position', () => {
      expect(() =>
        channelCreatePayloadSchema.parse({
          serverId: SERVER_ID,
          channel: { ...baseChannel, position: -1 },
        }),
      ).toThrow();
    });

    it('rejects non-integer position', () => {
      expect(() =>
        channelCreatePayloadSchema.parse({
          serverId: SERVER_ID,
          channel: { ...baseChannel, position: 1.5 },
        }),
      ).toThrow();
    });
  });

  describe('channelUpdatePayloadSchema', () => {
    it('accepts a payload with only required serverId + channelId', () => {
      expect(
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
        }),
      ).toBeDefined();
    });

    it('accepts a payload with every optional field set', () => {
      const p = {
        serverId: SERVER_ID,
        channelId: CHANNEL_ID,
        name: 'renamed',
        topic: 'New topic',
        position: 5,
        federationMode: 'force_off' as const,
        nsfw: true,
      };
      expect(channelUpdatePayloadSchema.parse(p)).toEqual(p);
    });

    it('accepts null topic', () => {
      expect(
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          topic: null,
        }),
      ).toBeDefined();
    });

    it('rejects missing channelId', () => {
      expect(() =>
        channelUpdatePayloadSchema.parse({ serverId: SERVER_ID }),
      ).toThrow();
    });

    it('rejects bad federationMode enum', () => {
      expect(() =>
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          federationMode: 'always_on',
        }),
      ).toThrow();
    });

    it('rejects name exceeding max length', () => {
      expect(() =>
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          name: 'x'.repeat(65),
        }),
      ).toThrow();
    });

    it('rejects empty name', () => {
      expect(() =>
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          name: '',
        }),
      ).toThrow();
    });

    it('rejects topic exceeding max length', () => {
      expect(() =>
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          topic: 'x'.repeat(1025),
        }),
      ).toThrow();
    });

    it('rejects negative position', () => {
      expect(() =>
        channelUpdatePayloadSchema.parse({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          position: -1,
        }),
      ).toThrow();
    });
  });

  describe('channelDeletePayloadSchema', () => {
    it('accepts a well-formed payload', () => {
      const p = { serverId: SERVER_ID, channelId: CHANNEL_ID };
      expect(channelDeletePayloadSchema.parse(p)).toEqual(p);
    });

    it('rejects missing channelId', () => {
      expect(() =>
        channelDeletePayloadSchema.parse({ serverId: SERVER_ID }),
      ).toThrow();
    });

    it('rejects missing serverId', () => {
      expect(() =>
        channelDeletePayloadSchema.parse({ channelId: CHANNEL_ID }),
      ).toThrow();
    });

    it('rejects invalid id format (non-ULID)', () => {
      expect(() =>
        channelDeletePayloadSchema.parse({
          serverId: 'not-a-ulid',
          channelId: CHANNEL_ID,
        }),
      ).toThrow();
    });
  });

  describe('ENVELOPE_EVENT_TYPES', () => {
    it('includes the 4 new server-mirror event types', () => {
      for (const t of [
        'server.update',
        'channel.create',
        'channel.update',
        'channel.delete',
      ]) {
        expect(ENVELOPE_EVENT_TYPES).toContain(t);
      }
    });
  });
});
