import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Format: version(1) | nonce(12) | tag(16) | ciphertext
 * Version 0x01 = AES-256-GCM. Bumping the version byte lets us migrate
 * to a different scheme later without ambiguous decode.
 */
const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export function encryptAtRest(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('encryptAtRest: key must be 32 bytes');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ct]);
}

export function decryptAtRest(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('decryptAtRest: key must be 32 bytes');
  if (blob.length < 1 + NONCE_LEN + TAG_LEN) {
    throw new Error('decryptAtRest: ciphertext too short');
  }
  const version = blob[0];
  if (version !== VERSION) throw new Error(`decryptAtRest: unknown version ${version}`);
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const tag = blob.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN);
  const ct = blob.subarray(1 + NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
