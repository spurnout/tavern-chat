import { describe, it, expect } from 'vitest';
import {
  memberJoinRequestPayloadSchema,
  serverSnapshotSchema,
  memberJoinedPayloadSchema,
  memberAddPayloadSchema,
  memberRemovePayloadSchema,
  memberLeavePayloadSchema,
  memberRemovedPayloadSchema,
  ENVELOPE_EVENT_TYPES,
} from '../../src/federation/index.js';

// Valid ULIDs (Crockford base32, 26 chars)
const SERVER_ID = '01HXYZ7N5K3M2P8VWQX9R1B0C0';
const CHANNEL_ID = '01HXYZ7N5K3M2P8VWQX9R1B0C1';

describe('federation/membership schemas', () => {
  describe('memberJoinRequestPayloadSchema', () => {
    it('accepts a well-formed payload', () => {
      const p = {
        inviteCode: 'abcd1234',
        joinerRemoteUserId: 'alice@b.example',
      };
      expect(memberJoinRequestPayloadSchema.parse(p)).toEqual(p);
    });

    it('rejects bad joinerRemoteUserId (no @)', () => {
      expect(() =>
        memberJoinRequestPayloadSchema.parse({
          inviteCode: 'abcd1234',
          joinerRemoteUserId: 'no-at-sign',
        }),
      ).toThrow();
    });

    it('rejects missing inviteCode', () => {
      expect(() =>
        memberJoinRequestPayloadSchema.parse({
          joinerRemoteUserId: 'alice@b.example',
        }),
      ).toThrow();
    });

    it('rejects inviteCode too short', () => {
      expect(() =>
        memberJoinRequestPayloadSchema.parse({
          inviteCode: 'abc',
          joinerRemoteUserId: 'alice@b.example',
        }),
      ).toThrow();
    });

    it('rejects inviteCode exceeding max length', () => {
      expect(() =>
        memberJoinRequestPayloadSchema.parse({
          inviteCode: 'x'.repeat(65),
          joinerRemoteUserId: 'alice@b.example',
        }),
      ).toThrow();
    });
  });

  describe('serverSnapshotSchema', () => {
    const baseSnapshot = {
      serverId: SERVER_ID,
      ownerRemoteUserId: 'owner@a.example',
      name: 'My Tavern',
      description: 'A cozy place',
      iconUrl: 'https://a.example/icon.png',
      federationEnabled: true as const,
      channels: [],
      members: [],
      createdAt: '2026-05-19T00:00:00Z',
    };

    it('accepts a well-formed snapshot with empty channels and members arrays', () => {
      const result = serverSnapshotSchema.parse(baseSnapshot);
      expect(result.serverId).toBe(SERVER_ID);
      expect(result.channels).toEqual([]);
      expect(result.members).toEqual([]);
    });

    it('applies defaults to channel (federationMode -> inherit, nsfw -> false)', () => {
      const snap = {
        ...baseSnapshot,
        channels: [
          {
            id: CHANNEL_ID,
            name: 'general',
            type: 'text' as const,
            topic: null,
            position: 0,
          },
        ],
      };
      const result = serverSnapshotSchema.parse(snap);
      expect(result.channels[0]?.federationMode).toBe('inherit');
      expect(result.channels[0]?.nsfw).toBe(false);
    });

    it('accepts a snapshot with members populated', () => {
      const snap = {
        ...baseSnapshot,
        members: [
          {
            remoteUserId: 'alice@b.example',
            displayName: 'Alice',
            joinedAt: '2026-05-19T00:00:00Z',
          },
        ],
      };
      expect(serverSnapshotSchema.parse(snap).members).toHaveLength(1);
    });

    it('accepts null description and iconUrl', () => {
      expect(
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          description: null,
          iconUrl: null,
        }),
      ).toBeDefined();
    });

    it('rejects bad ownerRemoteUserId', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          ownerRemoteUserId: 'no-at-sign',
        }),
      ).toThrow();
    });

    it('rejects missing required fields (name)', () => {
      const { name: _name, ...rest } = baseSnapshot;
      expect(() => serverSnapshotSchema.parse(rest)).toThrow();
    });

    it('rejects name exceeding max length', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          name: 'x'.repeat(65),
        }),
      ).toThrow();
    });

    it('rejects federationEnabled = false (must be literal true)', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          federationEnabled: false,
        }),
      ).toThrow();
    });

    it('rejects bad channel type enum', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          channels: [
            {
              id: CHANNEL_ID,
              name: 'general',
              type: 'voice',
              topic: null,
              position: 0,
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects bad channel federationMode enum', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          channels: [
            {
              id: CHANNEL_ID,
              name: 'general',
              type: 'text',
              topic: null,
              position: 0,
              federationMode: 'always_on',
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects channel topic exceeding max length', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          channels: [
            {
              id: CHANNEL_ID,
              name: 'general',
              type: 'text',
              topic: 'x'.repeat(1025),
              position: 0,
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects iconUrl that is not a valid URL', () => {
      expect(() =>
        serverSnapshotSchema.parse({
          ...baseSnapshot,
          iconUrl: 'not-a-url',
        }),
      ).toThrow();
    });
  });

  describe('memberJoinedPayloadSchema', () => {
    it('accepts a well-formed payload wrapping a snapshot', () => {
      const p = {
        inviteCode: 'abcd1234',
        serverSnapshot: {
          serverId: SERVER_ID,
          ownerRemoteUserId: 'owner@a.example',
          name: 'My Tavern',
          description: null,
          iconUrl: null,
          federationEnabled: true as const,
          channels: [],
          members: [],
          createdAt: '2026-05-19T00:00:00Z',
        },
      };
      expect(memberJoinedPayloadSchema.parse(p)).toBeDefined();
    });

    it('rejects missing serverSnapshot', () => {
      expect(() =>
        memberJoinedPayloadSchema.parse({ inviteCode: 'abcd1234' }),
      ).toThrow();
    });
  });

  describe('memberAddPayloadSchema', () => {
    it('accepts a well-formed payload', () => {
      const p = {
        serverId: SERVER_ID,
        memberRemoteUserId: 'bob@c.example',
        memberDisplayName: 'Bob',
        joinedAt: '2026-05-19T00:00:00Z',
      };
      expect(memberAddPayloadSchema.parse(p)).toEqual(p);
    });

    it('rejects bad memberRemoteUserId', () => {
      expect(() =>
        memberAddPayloadSchema.parse({
          serverId: SERVER_ID,
          memberRemoteUserId: 'broken',
          memberDisplayName: 'Bob',
          joinedAt: '2026-05-19T00:00:00Z',
        }),
      ).toThrow();
    });

    it('rejects missing joinedAt', () => {
      expect(() =>
        memberAddPayloadSchema.parse({
          serverId: SERVER_ID,
          memberRemoteUserId: 'bob@c.example',
          memberDisplayName: 'Bob',
        }),
      ).toThrow();
    });
  });

  describe('memberRemovePayloadSchema', () => {
    it('accepts a well-formed payload', () => {
      const p = {
        serverId: SERVER_ID,
        memberRemoteUserId: 'bob@c.example',
        reason: 'kicked' as const,
        removedAt: '2026-05-19T00:00:00Z',
      };
      expect(memberRemovePayloadSchema.parse(p)).toEqual(p);
    });

    it('accepts all valid reasons', () => {
      for (const reason of ['kicked', 'banned', 'left'] as const) {
        expect(
          memberRemovePayloadSchema.parse({
            serverId: SERVER_ID,
            memberRemoteUserId: 'bob@c.example',
            reason,
            removedAt: '2026-05-19T00:00:00Z',
          }),
        ).toBeDefined();
      }
    });

    it('rejects bad reason enum', () => {
      expect(() =>
        memberRemovePayloadSchema.parse({
          serverId: SERVER_ID,
          memberRemoteUserId: 'bob@c.example',
          reason: 'evicted',
          removedAt: '2026-05-19T00:00:00Z',
        }),
      ).toThrow();
    });

    it('rejects missing removedAt', () => {
      expect(() =>
        memberRemovePayloadSchema.parse({
          serverId: SERVER_ID,
          memberRemoteUserId: 'bob@c.example',
          reason: 'kicked',
        }),
      ).toThrow();
    });
  });

  describe('memberLeavePayloadSchema', () => {
    it('accepts a well-formed payload', () => {
      const p = {
        serverId: SERVER_ID,
        leaverRemoteUserId: 'bob@c.example',
        leftAt: '2026-05-19T00:00:00Z',
      };
      expect(memberLeavePayloadSchema.parse(p)).toEqual(p);
    });

    it('rejects bad leaverRemoteUserId', () => {
      expect(() =>
        memberLeavePayloadSchema.parse({
          serverId: SERVER_ID,
          leaverRemoteUserId: 'no-at',
          leftAt: '2026-05-19T00:00:00Z',
        }),
      ).toThrow();
    });

    it('rejects missing leftAt', () => {
      expect(() =>
        memberLeavePayloadSchema.parse({
          serverId: SERVER_ID,
          leaverRemoteUserId: 'bob@c.example',
        }),
      ).toThrow();
    });
  });

  describe('memberRemovedPayloadSchema', () => {
    it('accepts a well-formed payload', () => {
      const p = {
        serverId: SERVER_ID,
        leaverRemoteUserId: 'bob@c.example',
      };
      expect(memberRemovedPayloadSchema.parse(p)).toEqual(p);
    });

    it('rejects bad leaverRemoteUserId', () => {
      expect(() =>
        memberRemovedPayloadSchema.parse({
          serverId: SERVER_ID,
          leaverRemoteUserId: 'invalid',
        }),
      ).toThrow();
    });

    it('rejects missing serverId', () => {
      expect(() =>
        memberRemovedPayloadSchema.parse({
          leaverRemoteUserId: 'bob@c.example',
        }),
      ).toThrow();
    });
  });

  describe('ENVELOPE_EVENT_TYPES', () => {
    it('includes the 6 new membership event types', () => {
      for (const t of [
        'member.join_request',
        'member.joined',
        'member.add',
        'member.remove',
        'member.leave',
        'member.removed',
      ]) {
        expect(ENVELOPE_EVENT_TYPES).toContain(t);
      }
    });
  });
});
