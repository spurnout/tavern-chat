/**
 * P5-11 — unit coverage for the capability-filtering helpers used by the
 * well-known route and the peering handshake. Integration coverage
 * (`apps/api/test-integration/federation-dms-capability.test.ts`) drives the
 * actual HTTP routes; this file just pins down the pure-function behaviour
 * so a regression is caught without spinning up Postgres.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITIES, type Capability } from '@tavern/shared';
import { advertisedCapabilities } from '../src/routes/well-known.js';
import { intersectCapabilities } from '../src/services/federation-peering.js';

describe('advertisedCapabilities()', () => {
  it("includes 'dms' when FEDERATION_DMS_ENABLED is true", () => {
    const out = advertisedCapabilities({
      FEDERATION_DMS_ENABLED: true,
      FEDERATION_PRESENCE_ENABLED: true,
    });
    expect(out).toContain('dms');
    // Sanity — every other capability still surfaces.
    for (const cap of CAPABILITIES) {
      expect(out).toContain(cap);
    }
  });

  it("strips 'dms' when FEDERATION_DMS_ENABLED is false", () => {
    const out = advertisedCapabilities({
      FEDERATION_DMS_ENABLED: false,
      FEDERATION_PRESENCE_ENABLED: true,
    });
    expect(out).not.toContain('dms');
    // Other capabilities are untouched — this is a DM-only switch.
    for (const cap of CAPABILITIES) {
      if (cap === 'dms') continue;
      expect(out).toContain(cap);
    }
  });

  it("includes 'presence' when FEDERATION_PRESENCE_ENABLED is true (default)", () => {
    const out = advertisedCapabilities({
      FEDERATION_DMS_ENABLED: true,
      FEDERATION_PRESENCE_ENABLED: true,
    });
    expect(out).toContain('presence');
  });

  it("strips 'presence' when FEDERATION_PRESENCE_ENABLED is false", () => {
    const out = advertisedCapabilities({
      FEDERATION_DMS_ENABLED: true,
      FEDERATION_PRESENCE_ENABLED: false,
    });
    expect(out).not.toContain('presence');
    // Other capabilities are untouched — this is a presence-only switch.
    for (const cap of CAPABILITIES) {
      if (cap === 'presence') continue;
      expect(out).toContain(cap);
    }
  });

  it("strips BOTH 'dms' and 'presence' when both flags are off", () => {
    const out = advertisedCapabilities({
      FEDERATION_DMS_ENABLED: false,
      FEDERATION_PRESENCE_ENABLED: false,
    });
    expect(out).not.toContain('dms');
    expect(out).not.toContain('presence');
    for (const cap of CAPABILITIES) {
      if (cap === 'dms' || cap === 'presence') continue;
      expect(out).toContain(cap);
    }
  });
});

describe('intersectCapabilities()', () => {
  it('returns the intersection of two arrays', () => {
    const a: Capability[] = ['messages', 'dms', 'invites'];
    const b: Capability[] = ['messages', 'invites', 'moderation'];
    expect(intersectCapabilities(a, b)).toEqual(['messages', 'invites']);
  });

  it("doesn't include capabilities only one side claims", () => {
    const a: Capability[] = ['messages'];
    const b: Capability[] = ['dms'];
    expect(intersectCapabilities(a, b)).toEqual([]);
  });

  it('preserves the canonical order from the shared CAPABILITIES constant', () => {
    // Even if the inputs come in a weird order, the output follows the
    // declared order — two peers running the same software always agree on
    // the resulting array shape.
    const a: Capability[] = ['invites', 'messages', 'dms'];
    const b: Capability[] = ['dms', 'moderation', 'messages', 'invites'];
    const out = intersectCapabilities(a, b);
    expect(out).toEqual(
      CAPABILITIES.filter((c) => a.includes(c) && b.includes(c)),
    );
  });

  it('is idempotent when both sides advertise the full set', () => {
    const full: Capability[] = [...CAPABILITIES];
    expect(intersectCapabilities(full, full)).toEqual(full);
  });
});
