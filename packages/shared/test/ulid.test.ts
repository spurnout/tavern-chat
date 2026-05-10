import { describe, expect, it } from 'vitest';
import { isUlid, ulid, ulidTimestamp } from '../src/ulid.js';

describe('ulid', () => {
  it('produces 26-character Crockford base32 strings', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('embeds the supplied timestamp', () => {
    const t = 1_700_000_000_000;
    const id = ulid(t);
    expect(ulidTimestamp(id)).toBe(t);
  });

  it('sorts ULIDs created in order lexicographically by time', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a < b).toBe(true);
  });

  it('rejects strings with invalid characters via isUlid', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    // Includes I (excluded from Crockford base32)
    expect(isUlid('I'.repeat(26))).toBe(false);
  });
});
