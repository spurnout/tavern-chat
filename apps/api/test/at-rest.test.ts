import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptAtRest, decryptAtRest } from '../src/lib/at-rest.js';
import { loadDataKey } from '../src/lib/data-key.js';

describe('at-rest AES-256-GCM', () => {
  const key = randomBytes(32);

  it('roundtrips plaintext', () => {
    const plaintext = Buffer.from('hello federation');
    const ct = encryptAtRest(plaintext, key);
    expect(decryptAtRest(ct, key)).toEqual(plaintext);
  });

  it('produces a different ciphertext each call (nonce uniqueness)', () => {
    const a = encryptAtRest(Buffer.from('x'), key);
    const b = encryptAtRest(Buffer.from('x'), key);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects ciphertext with the wrong key', () => {
    const other = randomBytes(32);
    const ct = encryptAtRest(Buffer.from('secret'), key);
    expect(() => decryptAtRest(ct, other)).toThrow();
  });

  it('rejects tampered ciphertext (auth tag fails)', () => {
    const ct = encryptAtRest(Buffer.from('secret'), key);
    ct[ct.length - 1] ^= 0x01;
    expect(() => decryptAtRest(ct, key)).toThrow();
  });

  it('rejects unknown version byte', () => {
    const ct = encryptAtRest(Buffer.from('x'), key);
    ct[0] = 0xff;
    expect(() => decryptAtRest(ct, key)).toThrow(/version/);
  });
});

describe('TAVERN_DATA_KEY loader', () => {
  it('decodes a base64-encoded 32-byte key', () => {
    const raw = randomBytes(32);
    const loaded = loadDataKey(raw.toString('base64'));
    expect(loaded.equals(raw)).toBe(true);
  });

  it('rejects when value is not base64', () => {
    expect(() => loadDataKey('!!!not-base64!!!')).toThrow();
  });

  it('rejects when decoded length is not 32 bytes', () => {
    expect(() => loadDataKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });

  it('rejects when empty', () => {
    expect(() => loadDataKey('')).toThrow();
    expect(() => loadDataKey(undefined)).toThrow();
  });
});
