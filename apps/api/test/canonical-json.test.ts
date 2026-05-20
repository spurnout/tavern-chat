import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/lib/canonical-json.js';

describe('RFC 8785 canonical JSON', () => {
  it('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ k: [1, 2, { x: 'y' }] })).toBe('{"k":[1,2,{"x":"y"}]}');
  });

  it('canonicalizes nested objects', () => {
    const out = canonicalize({ outer: { z: 1, a: 2 }, alpha: true });
    expect(out).toBe('{"alpha":true,"outer":{"a":2,"z":1}}');
  });

  it('escapes control chars and unicode per JSON spec', () => {
    expect(canonicalize({ s: 'a\nb' })).toBe('{"s":"a\\nb"}');
  });

  it('handles arrays without reordering them', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives at top level', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
  });

  it('omits undefined object values (JSON convention)', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });
});
