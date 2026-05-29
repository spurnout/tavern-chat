/**
 * Characterization tests for the AES-256-GCM at-rest envelope.
 *
 * Format under test: version(1) | nonce(12) | tag(16) | ciphertext.
 * Covers the round-trip, authentication failures (tampered ciphertext, tampered
 * tag, wrong key), and every guard branch: bad key length on both functions,
 * a too-short blob, and an unknown version byte.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptAtRest, decryptAtRest } from './at-rest.js';

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + NONCE_LEN + TAG_LEN; // 29

function key32(): Buffer {
  return randomBytes(32);
}

describe('encryptAtRest / decryptAtRest — round-trip', () => {
  it('decrypts back to the original plaintext', () => {
    const key = key32();
    const plaintext = Buffer.from('attack at dawn', 'utf8');
    const blob = encryptAtRest(plaintext, key);
    expect(decryptAtRest(blob, key).equals(plaintext)).toBe(true);
  });

  it('round-trips an empty plaintext', () => {
    const key = key32();
    const blob = encryptAtRest(Buffer.alloc(0), key);
    // Empty plaintext still produces a full header (version + nonce + tag).
    expect(blob.length).toBe(HEADER_LEN);
    expect(decryptAtRest(blob, key).length).toBe(0);
  });

  it('round-trips a large binary plaintext', () => {
    const key = key32();
    const plaintext = randomBytes(4096);
    const blob = encryptAtRest(plaintext, key);
    expect(decryptAtRest(blob, key).equals(plaintext)).toBe(true);
  });

  it('emits the expected version byte and header layout', () => {
    const key = key32();
    const plaintext = Buffer.from('hello', 'utf8');
    const blob = encryptAtRest(plaintext, key);
    expect(blob[0]).toBe(VERSION);
    // ciphertext length for GCM equals plaintext length.
    expect(blob.length).toBe(HEADER_LEN + plaintext.length);
  });

  it('uses a fresh random nonce per call (ciphertexts differ for same input)', () => {
    const key = key32();
    const plaintext = Buffer.from('same message', 'utf8');
    const a = encryptAtRest(plaintext, key);
    const b = encryptAtRest(plaintext, key);
    expect(a.equals(b)).toBe(false);
    // Both still decrypt correctly.
    expect(decryptAtRest(a, key).equals(plaintext)).toBe(true);
    expect(decryptAtRest(b, key).equals(plaintext)).toBe(true);
  });
});

describe('decryptAtRest — authentication failures', () => {
  it('throws when the ciphertext body is tampered', () => {
    const key = key32();
    const blob = encryptAtRest(Buffer.from('confidential payload', 'utf8'), key);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff; // flip a ciphertext bit
    expect(() => decryptAtRest(tampered, key)).toThrow();
  });

  it('throws when the auth tag is tampered', () => {
    const key = key32();
    const blob = encryptAtRest(Buffer.from('confidential payload', 'utf8'), key);
    const tampered = Buffer.from(blob);
    tampered[1 + NONCE_LEN] = (tampered[1 + NONCE_LEN] ?? 0) ^ 0xff; // flip a bit inside the tag region
    expect(() => decryptAtRest(tampered, key)).toThrow();
  });

  it('throws when decrypting with the wrong key', () => {
    const blob = encryptAtRest(Buffer.from('confidential payload', 'utf8'), key32());
    expect(() => decryptAtRest(blob, key32())).toThrow();
  });
});

describe('encryptAtRest — key-length guard', () => {
  it('throws on a key shorter than 32 bytes', () => {
    expect(() => encryptAtRest(Buffer.from('x'), Buffer.alloc(16))).toThrow(
      /key must be 32 bytes/,
    );
  });

  it('throws on a key longer than 32 bytes', () => {
    expect(() => encryptAtRest(Buffer.from('x'), Buffer.alloc(33))).toThrow(
      /key must be 32 bytes/,
    );
  });
});

describe('decryptAtRest — guard branches', () => {
  it('throws on a key that is not 32 bytes', () => {
    const blob = encryptAtRest(Buffer.from('x'), key32());
    expect(() => decryptAtRest(blob, Buffer.alloc(16))).toThrow(/key must be 32 bytes/);
  });

  it('throws when the blob is shorter than the minimum header', () => {
    expect(() => decryptAtRest(Buffer.alloc(HEADER_LEN - 1), key32())).toThrow(
      /ciphertext too short/,
    );
  });

  it('throws on an unknown version byte', () => {
    const key = key32();
    const blob = encryptAtRest(Buffer.from('payload', 'utf8'), key);
    const badVersion = Buffer.from(blob);
    badVersion[0] = 0x02; // not the supported VERSION
    expect(() => decryptAtRest(badVersion, key)).toThrow(/unknown version 2/);
  });
});
