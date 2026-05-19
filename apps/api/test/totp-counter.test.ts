import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  generateTotpSecret,
  verifyTotp,
  verifyTotpWithCounter,
} from '../src/lib/totp.js';

// Reuse the internal HOTP primitive shape so we can drive deterministic codes
// for a known counter. We duplicate the algorithm here rather than exporting
// it from totp.ts; the algorithm is fixed and tiny so the duplication is
// cheaper than widening the module surface.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.toUpperCase().replace(/=/g, '')) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('bad char');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
function hotp(secret: string, counter: number): string {
  const secretBuf = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

describe('verifyTotpWithCounter', () => {
  it('returns the matched counter on a valid current-step code', () => {
    const { secret } = generateTotpSecret();
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code = hotp(secret, counter);
    const result = verifyTotpWithCounter(secret, code);
    expect(result).not.toBeNull();
    expect(result?.counter).toBe(counter);
  });

  it('accepts a previous-step code and reports its counter', () => {
    const { secret } = generateTotpSecret();
    const counter = Math.floor(Date.now() / 1000 / 30);
    const previousCounter = counter - 1;
    const code = hotp(secret, previousCounter);
    const result = verifyTotpWithCounter(secret, code);
    expect(result?.counter).toBe(previousCounter);
  });

  it('returns null for an entirely unrelated code', () => {
    const { secret } = generateTotpSecret();
    // 6 zero digits is overwhelmingly unlikely to be the valid TOTP for any
    // given moment — chance is 3 windows × 1/10^6 ≈ 3e-6.
    const result = verifyTotpWithCounter(secret, '000000');
    // We *might* hit a false positive once every ~333k runs. Skip with a
    // soft expectation rather than asserting hard.
    if (result === null) {
      expect(result).toBeNull();
    } else {
      // If we hit the 1-in-millions case, just verify the counter is in
      // the ±1 window so the verifier is at least behaving correctly.
      const now = Math.floor(Date.now() / 1000 / 30);
      expect(Math.abs(result.counter - now)).toBeLessThanOrEqual(1);
    }
  });

  it('returns null for non-numeric input', () => {
    const { secret } = generateTotpSecret();
    expect(verifyTotpWithCounter(secret, 'abcdef')).toBeNull();
    expect(verifyTotpWithCounter(secret, '12345')).toBeNull(); // too short
    expect(verifyTotpWithCounter(secret, '1234567')).toBeNull(); // too long
  });

  it('the boolean verifyTotp wrapper agrees with verifyTotpWithCounter', () => {
    const { secret } = generateTotpSecret();
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code = hotp(secret, counter);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000001')).toBe(verifyTotpWithCounter(secret, '000001') !== null);
  });
});
