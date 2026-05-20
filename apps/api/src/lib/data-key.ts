/**
 * Loads and validates TAVERN_DATA_KEY. Used only by the federation key store
 * for now; longer-term this will protect other at-rest secrets too.
 *
 * Format: base64-encoded 32 raw bytes (256 bits). Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function loadDataKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error('TAVERN_DATA_KEY is required when FEDERATION_ENABLED=true');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    throw new Error('TAVERN_DATA_KEY: invalid base64');
  }
  // Buffer.from with non-base64 input is silently lossy — verify length.
  if (decoded.length !== 32) {
    throw new Error(`TAVERN_DATA_KEY: must decode to exactly 32 bytes (got ${decoded.length})`);
  }
  // Round-trip check: re-encoding must match the input to catch invalid chars.
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('TAVERN_DATA_KEY: invalid base64 (round-trip mismatch)');
  }
  return decoded;
}
