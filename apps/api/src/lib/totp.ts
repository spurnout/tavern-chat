import crypto from 'node:crypto';

/**
 * Minimal RFC-6238 TOTP / RFC-4648 base32 implementation. Built in-house
 * to avoid adding a runtime dependency for a single small primitive.
 *
 * - 30-second window, 6 digits, SHA-1 (the de-facto authenticator default).
 * - Verification accepts ±1 step to tolerate clock drift.
 * - Secrets are 160-bit (20 bytes random) — wider than the RFC's 80-bit
 *   minimum but matches Aegis / Authy / Google Authenticator defaults.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    const idx = parseInt(chunk, 2);
    out += BASE32[idx] ?? '';
  }
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.toUpperCase().replace(/=/g, '')) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function generateTotpSecret(): { secret: string } {
  return { secret: base32Encode(crypto.randomBytes(20)) };
}

export function otpauthUrl(secret: string, label: string, issuer: string): string {
  const encodedLabel = encodeURIComponent(label);
  const encodedIssuer = encodeURIComponent(issuer);
  return (
    `otpauth://totp/${encodedIssuer}:${encodedLabel}` +
    `?secret=${secret}&issuer=${encodedIssuer}&period=30&digits=6&algorithm=SHA1`
  );
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let secretBuf: Buffer;
  try {
    secretBuf = base32Decode(secret);
  } catch {
    return false;
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(secretBuf, counter + w) === code) return true;
  }
  return false;
}

/**
 * Generate `n` backup codes — random 10-character hyphenated tokens, e.g.
 * "8H29-K4MX-2WPB". Returned in plaintext (caller stores hashed copies).
 */
export function generateBackupCodes(n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const raw = crypto.randomBytes(7).toString('base64url').slice(0, 12).toUpperCase();
    out.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return out;
}

export function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
}
