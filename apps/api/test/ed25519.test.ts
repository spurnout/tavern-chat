import { describe, expect, it } from 'vitest';
import { generateKeyPair, sign, verify, publicKeyFromRaw, exportPublicKeyRaw } from '../src/lib/ed25519.js';

describe('ed25519', () => {
  it('round-trips sign and verify', () => {
    const kp = generateKeyPair();
    const msg = Buffer.from('hello');
    const sig = sign(msg, kp.privateKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
  });

  it('rejects a signature from a different key', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sig = sign(Buffer.from('x'), a.privateKey);
    expect(verify(Buffer.from('x'), sig, b.publicKey)).toBe(false);
  });

  it('rejects a tampered message', () => {
    const kp = generateKeyPair();
    const sig = sign(Buffer.from('hello'), kp.privateKey);
    expect(verify(Buffer.from('hellx'), sig, kp.publicKey)).toBe(false);
  });

  it('exports and re-imports a public key as 32 raw bytes', () => {
    const kp = generateKeyPair();
    const raw = exportPublicKeyRaw(kp.publicKey);
    expect(raw.length).toBe(32);
    const reimported = publicKeyFromRaw(raw);
    const sig = sign(Buffer.from('x'), kp.privateKey);
    expect(verify(Buffer.from('x'), sig, reimported)).toBe(true);
  });
});
