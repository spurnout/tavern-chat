/**
 * Pure-function tests for `federatedDmPairKey`.
 *
 * The helper is the federation-aware counterpart to `directPairKey`: it
 * accepts qualified ids of the form `<localpart>@<host>` and produces the
 * sorted "a:b" form that backs DmChannel.pairKey for cross-instance 1:1s.
 */
import { describe, expect, it } from 'vitest';
import { federatedDmPairKey } from '../src/services/dm-service.js';

describe('federatedDmPairKey', () => {
  const ALICE_A = 'alice@a.example';
  const BOB_B = 'bob@b.example';

  it('is symmetric: same output regardless of argument order', () => {
    expect(federatedDmPairKey(ALICE_A, BOB_B)).toBe(federatedDmPairKey(BOB_B, ALICE_A));
  });

  it('returns the sorted form `<lo>:<hi>`', () => {
    // 'alice@a.example' < 'bob@b.example' lexicographically.
    expect(federatedDmPairKey(ALICE_A, BOB_B)).toBe(`${ALICE_A}:${BOB_B}`);
    expect(federatedDmPairKey(BOB_B, ALICE_A)).toBe(`${ALICE_A}:${BOB_B}`);
  });

  it('handles two ids on the same host', () => {
    const a = 'alice@a.example';
    const c = 'carol@a.example';
    expect(federatedDmPairKey(a, c)).toBe(`${a}:${c}`);
    expect(federatedDmPairKey(c, a)).toBe(`${a}:${c}`);
  });

  it('distinguishes pairs that share a localpart on different hosts', () => {
    const aOnA = 'alice@a.example';
    const aOnB = 'alice@b.example';
    expect(federatedDmPairKey(aOnA, aOnB)).toBe(`${aOnA}:${aOnB}`);
    // Same localpart on the same host would collapse but that's a
    // self-DM and rejected upstream by findOrCreateDirectDm.
    expect(federatedDmPairKey(aOnA, aOnA)).toBe(`${aOnA}:${aOnA}`);
  });

  it('produces different keys for different pairs', () => {
    expect(federatedDmPairKey('alice@a.example', 'bob@b.example')).not.toBe(
      federatedDmPairKey('alice@a.example', 'carol@b.example'),
    );
  });
});
