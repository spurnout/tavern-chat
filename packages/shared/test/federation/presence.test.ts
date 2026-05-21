import { describe, it, expect } from 'vitest';
import {
  federatedPresenceUpdatePayloadSchema,
  federatedPresenceSchema,
  ENVELOPE_EVENT_TYPES,
} from '../../src/federation/index.js';

describe('federation/presence schemas', () => {
  describe('federatedPresenceSchema', () => {
    it('accepts the four valid presence states', () => {
      for (const p of ['active', 'idle', 'dnd', 'offline'] as const) {
        expect(federatedPresenceSchema.parse(p)).toBe(p);
      }
    });

    it('rejects an unknown presence string', () => {
      expect(() => federatedPresenceSchema.parse('busy')).toThrow();
    });
  });

  describe('federatedPresenceUpdatePayloadSchema', () => {
    it('accepts a fully-populated happy-path payload', () => {
      const p = {
        userRemoteUserId: 'alice@a.example',
        presence: 'active' as const,
        customStatus: 'In a session',
        customStatusExpiresAt: '2026-05-21T12:00:00Z',
        updatedAt: '2026-05-21T11:00:00Z',
      };
      expect(federatedPresenceUpdatePayloadSchema.parse(p)).toEqual(p);
    });

    it('accepts customStatus: null with null expiresAt (presence-only update)', () => {
      const p = {
        userRemoteUserId: 'alice@a.example',
        presence: 'idle' as const,
        customStatus: null,
        customStatusExpiresAt: null,
        updatedAt: '2026-05-21T11:00:00Z',
      };
      expect(federatedPresenceUpdatePayloadSchema.parse(p)).toEqual(p);
    });

    it('accepts customStatus set with null expiresAt (status that does not auto-clear)', () => {
      const p = {
        userRemoteUserId: 'alice@a.example',
        presence: 'active' as const,
        customStatus: 'Heads-down',
        customStatusExpiresAt: null,
        updatedAt: '2026-05-21T11:00:00Z',
      };
      expect(federatedPresenceUpdatePayloadSchema.parse(p)).toEqual(p);
    });

    it('accepts customStatus: null with no expiry (both nullable variants null)', () => {
      const p = {
        userRemoteUserId: 'alice@a.example',
        presence: 'offline' as const,
        customStatus: null,
        customStatusExpiresAt: null,
        updatedAt: '2026-05-21T11:00:00Z',
      };
      expect(federatedPresenceUpdatePayloadSchema.parse(p)).toEqual(p);
    });

    it('rejects a bad presence string', () => {
      expect(() =>
        federatedPresenceUpdatePayloadSchema.parse({
          userRemoteUserId: 'alice@a.example',
          presence: 'busy',
          customStatus: null,
          customStatusExpiresAt: null,
          updatedAt: '2026-05-21T11:00:00Z',
        }),
      ).toThrow();
    });

    it('rejects a non-ISO-datetime updatedAt', () => {
      expect(() =>
        federatedPresenceUpdatePayloadSchema.parse({
          userRemoteUserId: 'alice@a.example',
          presence: 'active',
          customStatus: null,
          customStatusExpiresAt: null,
          updatedAt: 'yesterday',
        }),
      ).toThrow();
    });

    it('rejects customStatus exceeding 128 chars', () => {
      expect(() =>
        federatedPresenceUpdatePayloadSchema.parse({
          userRemoteUserId: 'alice@a.example',
          presence: 'active',
          customStatus: 'x'.repeat(129),
          customStatusExpiresAt: null,
          updatedAt: '2026-05-21T11:00:00Z',
        }),
      ).toThrow();
    });

    it('rejects an empty-string customStatus (min 1)', () => {
      expect(() =>
        federatedPresenceUpdatePayloadSchema.parse({
          userRemoteUserId: 'alice@a.example',
          presence: 'active',
          customStatus: '',
          customStatusExpiresAt: null,
          updatedAt: '2026-05-21T11:00:00Z',
        }),
      ).toThrow();
    });

    it('rejects a bad userRemoteUserId (no @)', () => {
      expect(() =>
        federatedPresenceUpdatePayloadSchema.parse({
          userRemoteUserId: 'no-at-sign',
          presence: 'active',
          customStatus: null,
          customStatusExpiresAt: null,
          updatedAt: '2026-05-21T11:00:00Z',
        }),
      ).toThrow();
    });
  });

  describe('ENVELOPE_EVENT_TYPES', () => {
    it('includes presence.update', () => {
      expect(ENVELOPE_EVENT_TYPES).toContain('presence.update');
    });

    it('places presence.update last (after dm.reaction.remove)', () => {
      const last = ENVELOPE_EVENT_TYPES[ENVELOPE_EVENT_TYPES.length - 1];
      expect(last).toBe('presence.update');
      const dmReactionRemoveIdx = ENVELOPE_EVENT_TYPES.indexOf('dm.reaction.remove');
      const presenceUpdateIdx = ENVELOPE_EVENT_TYPES.indexOf('presence.update');
      expect(presenceUpdateIdx).toBe(dmReactionRemoveIdx + 1);
    });
  });
});
