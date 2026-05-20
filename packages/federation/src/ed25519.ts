import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto';

export interface Ed25519Pair {
  publicKey: KeyObject;
  /** PKCS8 KeyObject — call exportPrivateKeyPkcs8 to serialize. */
  privateKey: KeyObject;
}

export function generateKeyPair(): Ed25519Pair {
  return generateKeyPairSync('ed25519');
}

export function sign(message: Buffer, privateKey: KeyObject): Buffer {
  // Ed25519 uses null algorithm — the API takes the message directly.
  return nodeSign(null, message, privateKey);
}

export function verify(message: Buffer, signature: Buffer, publicKey: KeyObject): boolean {
  try {
    return nodeVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

export function exportPublicKeyRaw(key: KeyObject): Buffer {
  // DER (SPKI) header for ed25519 is fixed 12 bytes; raw key is the last 32.
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('publicKeyFromRaw: expected 32 bytes');
  // Prepend the fixed SPKI header for ed25519.
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([prefix, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function exportPrivateKeyPkcs8(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'der', type: 'pkcs8' }));
}

export function privateKeyFromPkcs8(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
