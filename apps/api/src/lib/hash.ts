import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 hex of a string. Used to store opaque tokens at rest. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomTokenHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
