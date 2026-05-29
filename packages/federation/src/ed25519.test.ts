/**
 * Characterization tests for the ed25519 signing primitives.
 *
 * These cover the happy path (generate → sign → verify), the three ways a
 * verification must fail (tampered message, tampered signature, wrong key),
 * the raw-public-key and PKCS8-private-key export/import round-trips, and the
 * length guard on `publicKeyFromRaw`.
 */

import { createSecretKey, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  sign,
  verify,
  exportPublicKeyRaw,
  publicKeyFromRaw,
  exportPrivateKeyPkcs8,
  privateKeyFromPkcs8,
} from './ed25519.js';

const MESSAGE = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');

describe('generateKeyPair', () => {
  it('returns an ed25519 public/private KeyObject pair', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey.type).toBe('public');
    expect(kp.privateKey.type).toBe('private');
    expect(kp.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(kp.privateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('produces a distinct keypair on each call', () => {
    const a = exportPublicKeyRaw(generateKeyPair().publicKey);
    const b = exportPublicKeyRaw(generateKeyPair().publicKey);
    expect(a.equals(b)).toBe(false);
  });
});

describe('sign / verify', () => {
  it('signs a message and verifies it with the matching public key', () => {
    const kp = generateKeyPair();
    const sig = sign(MESSAGE, kp.privateKey);
    // Ed25519 signatures are 64 bytes.
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
    expect(verify(MESSAGE, sig, kp.publicKey)).toBe(true);
  });

  it('produces a deterministic signature for the same message + key', () => {
    const kp = generateKeyPair();
    const a = sign(MESSAGE, kp.privateKey);
    const b = sign(MESSAGE, kp.privateKey);
    // Ed25519 is deterministic (RFC 8032).
    expect(a.equals(b)).toBe(true);
  });

  it('verifies an empty-message signature', () => {
    const kp = generateKeyPair();
    const empty = Buffer.alloc(0);
    const sig = sign(empty, kp.privateKey);
    expect(verify(empty, sig, kp.publicKey)).toBe(true);
  });

  it('FAILS verification when the message is tampered', () => {
    const kp = generateKeyPair();
    const sig = sign(MESSAGE, kp.privateKey);
    const tampered = Buffer.from('the quick brown fox jumps over the lazy dot', 'utf8');
    expect(verify(tampered, sig, kp.publicKey)).toBe(false);
  });

  it('FAILS verification when the signature is tampered', () => {
    const kp = generateKeyPair();
    const sig = sign(MESSAGE, kp.privateKey);
    const tampered = Buffer.from(sig);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff; // flip a bit in the signature
    expect(verify(MESSAGE, tampered, kp.publicKey)).toBe(false);
  });

  it('FAILS verification with a different (wrong) public key', () => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const sig = sign(MESSAGE, signer.privateKey);
    expect(verify(MESSAGE, sig, other.publicKey)).toBe(false);
  });

  it('returns false (does not throw) when the signature is a malformed length', () => {
    const kp = generateKeyPair();
    // A 10-byte "signature" is structurally invalid; verify must report false
    // rather than propagate (Node returns false here on current runtimes).
    expect(verify(MESSAGE, Buffer.alloc(10), kp.publicKey)).toBe(false);
  });

  it('catches a thrown crypto error and returns false (incompatible key type)', () => {
    const kp = generateKeyPair();
    const sig = sign(MESSAGE, kp.privateKey);
    // A symmetric secret KeyObject satisfies the KeyObject type but makes the
    // underlying node verify() throw (ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE).
    // The wrapper's try/catch must swallow it and return false.
    const symmetricKey = createSecretKey(Buffer.alloc(32)) as unknown as KeyObject;
    expect(verify(MESSAGE, sig, symmetricKey)).toBe(false);
  });
});

describe('exportPublicKeyRaw / publicKeyFromRaw', () => {
  it('exports a 32-byte raw public key', () => {
    const kp = generateKeyPair();
    const raw = exportPublicKeyRaw(kp.publicKey);
    expect(raw).toBeInstanceOf(Buffer);
    expect(raw.length).toBe(32);
  });

  it('round-trips raw -> KeyObject -> raw to the same bytes', () => {
    const kp = generateKeyPair();
    const raw = exportPublicKeyRaw(kp.publicKey);
    const reimported = publicKeyFromRaw(raw);
    expect(reimported.type).toBe('public');
    expect(reimported.asymmetricKeyType).toBe('ed25519');
    expect(exportPublicKeyRaw(reimported).equals(raw)).toBe(true);
  });

  it('a re-imported public key still verifies a signature from the original private key', () => {
    const kp = generateKeyPair();
    const sig = sign(MESSAGE, kp.privateKey);
    const reimported = publicKeyFromRaw(exportPublicKeyRaw(kp.publicKey));
    expect(verify(MESSAGE, sig, reimported)).toBe(true);
  });

  it('throws on a raw key that is not 32 bytes (too short)', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow(/expected 32 bytes/);
  });

  it('throws on a raw key that is not 32 bytes (too long)', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(33))).toThrow(/expected 32 bytes/);
  });
});

describe('exportPrivateKeyPkcs8 / privateKeyFromPkcs8', () => {
  it('round-trips a private key through PKCS8 DER and still signs verifiably', () => {
    const kp = generateKeyPair();
    const der = exportPrivateKeyPkcs8(kp.privateKey);
    expect(der).toBeInstanceOf(Buffer);
    expect(der.length).toBeGreaterThan(0);

    const reimported = privateKeyFromPkcs8(der);
    expect(reimported.type).toBe('private');
    expect(reimported.asymmetricKeyType).toBe('ed25519');

    // A signature from the re-imported private key verifies against the
    // original public key — proving the round-trip preserved the key.
    const sig = sign(MESSAGE, reimported);
    expect(verify(MESSAGE, sig, kp.publicKey)).toBe(true);
    // And it equals the signature from the original key (Ed25519 determinism).
    expect(sig.equals(sign(MESSAGE, kp.privateKey))).toBe(true);
  });
});
