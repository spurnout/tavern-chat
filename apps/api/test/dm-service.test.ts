import { describe, expect, it } from 'vitest';
import { directPairKey } from '../src/services/dm-service.js';

describe('directPairKey', () => {
  // Two ULIDs in lexicographic order.
  const LOW = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
  const HIGH = '01HZX7Q4ZZK9V0G8WMC2P5N6BR';

  it('is symmetric: directPairKey(a, b) === directPairKey(b, a)', () => {
    expect(directPairKey(LOW, HIGH)).toBe(directPairKey(HIGH, LOW));
  });

  it('produces the sorted form regardless of argument order', () => {
    expect(directPairKey(HIGH, LOW)).toBe(`${LOW}:${HIGH}`);
    expect(directPairKey(LOW, HIGH)).toBe(`${LOW}:${HIGH}`);
  });

  it('distinguishes different pairs', () => {
    const OTHER = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
    expect(directPairKey(LOW, HIGH)).not.toBe(directPairKey(LOW, OTHER));
  });
});
