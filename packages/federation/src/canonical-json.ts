/**
 * RFC 8785 / JCS subset. Sufficient for federation envelopes:
 * - Object keys sorted by UTF-16 code-unit (the default of Array#sort on JS strings)
 * - No insignificant whitespace
 * - JSON.stringify is RFC-8259 conformant for strings, booleans, null, and finite
 *   safe-range numbers — which covers all values we put inside an envelope (IDs are
 *   strings, capabilities are strings, timestamps are ISO strings).
 *
 * Rejects: undefined at the top level, NaN, +/-Infinity, BigInt, symbols, functions.
 * Allowed: nested objects/arrays of the above primitives.
 *
 * **Subtle contract for callers:** `undefined` inside an array is replaced with
 * `null` (line 31), but `undefined` as an object property value is silently
 * **omitted** (line 35). This matches `JSON.stringify` semantics and the JCS
 * spec, but means an envelope built with an optional field set to `undefined`
 * on instance A will produce a different canonical string than the same
 * envelope built with that field set to `null` — and the resulting signature
 * won't verify on the other side. Callers MUST normalise optional fields to
 * `null` (or omit them entirely) before signing; do not rely on `undefined`.
 *
 * **Non-ASCII keys:** the sort is JS `Array#sort` (UTF-16 code-unit order),
 * which matches JCS for the BMP but diverges from a true Unicode code-point
 * sort for characters above U+FFFF. All envelope keys today are ASCII (no
 * concern). Add a per-key allowlist in the schema if non-ASCII keys are
 * ever introduced.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('canonicalize: top-level value cannot be undefined');
  }
  return stringify(value);
}

function stringify(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalize: non-finite number');
      return JSON.stringify(v);
    case 'string':
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        return '[' + v.map((item) => (item === undefined ? 'null' : stringify(item))).join(',') + ']';
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      const parts = keys.map((k) => JSON.stringify(k) + ':' + stringify(obj[k]));
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof v}`);
  }
}
