import { randomBytes } from 'node:crypto';

/**
 * 10-character base64url invite code: enough entropy that brute-forcing
 * is impractical, short enough to type by hand if needed.
 */
export function generateInviteCode(): string {
  return randomBytes(8).toString('base64url').toUpperCase().slice(0, 10);
}
