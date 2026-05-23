/**
 * Minimal ULID implementation (Crockford base32, 26 chars, 48-bit time + 80-bit random).
 *
 * Why we ship our own: it's ~50 LOC, has no dependencies, sorts lexicographically
 * by creation time, and avoids a runtime dep just for IDs.
 *
 * Generates monotonic IDs within the same millisecond (per process).
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function getCryptoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // Node 18+ and every supported browser exposes globalThis.crypto. If a
  // future target environment doesn't, we want a hard failure rather than
  // silently downgrading IDs to Math.random() — a non-cryptographic source
  // here would let an attacker who has seen one ULID predict the next.
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
    throw new Error('ulid: secure crypto.getRandomValues is required');
  }
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(now: number): string {
  let value = now;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = value % ENCODING_LEN;
    out[i] = ENCODING[mod] as string;
    value = (value - mod) / ENCODING_LEN;
  }
  return out.join('');
}

function encodeRandomFromArray(arr: number[]): string {
  return arr.map((v) => ENCODING[v % ENCODING_LEN]).join('');
}

function newRandomDigits(): number[] {
  const bytes = getCryptoRandomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % ENCODING_LEN);
}

function incrementRandomDigits(arr: number[]): number[] {
  const out = [...arr];
  for (let i = out.length - 1; i >= 0; i--) {
    const v = (out[i] ?? 0) + 1;
    if (v < ENCODING_LEN) {
      out[i] = v;
      return out;
    }
    out[i] = 0;
  }
  // Overflow — reseed.
  return newRandomDigits();
}

export function ulid(timestamp?: number): string {
  const now = timestamp ?? Date.now();
  let randomDigits: number[];
  if (now === lastTime && lastRandom.length === RANDOM_LEN) {
    randomDigits = incrementRandomDigits(lastRandom);
  } else {
    randomDigits = newRandomDigits();
  }
  lastTime = now;
  lastRandom = randomDigits;
  return encodeTime(now) + encodeRandomFromArray(randomDigits);
}

export function isUlid(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (let i = 0; i < value.length; i++) {
    if (!ENCODING.includes(value[i] as string)) return false;
  }
  return true;
}

/** Decode the embedded timestamp from a ULID. */
export function ulidTimestamp(id: string): number {
  if (id.length < TIME_LEN) throw new Error('Invalid ULID');
  let result = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const ch = id[i] as string;
    const idx = ENCODING.indexOf(ch);
    if (idx < 0) throw new Error('Invalid ULID character');
    result = result * ENCODING_LEN + idx;
  }
  return result;
}
