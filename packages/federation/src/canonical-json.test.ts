/**
 * Characterization tests for the RFC-8785/JCS-subset canonicalizer used as the
 * signing preimage for federation envelopes.
 *
 * The load-bearing properties are: deterministic key ordering (insertion order
 * must NOT matter), no insignificant whitespace, recursion through nested
 * objects/arrays, the documented `undefined` handling (omitted as an object
 * value, replaced with `null` inside arrays), and the type guards (top-level
 * undefined, non-finite numbers, unsupported types).
 */

import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical-json.js';

describe('canonicalize — primitives', () => {
  it('serializes null', () => {
    expect(canonicalize(null)).toBe('null');
  });

  it('serializes booleans', () => {
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('serializes finite numbers (matching JSON.stringify)', () => {
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(-17)).toBe('-17');
    expect(canonicalize(3.5)).toBe('3.5');
  });

  it('serializes strings with JSON escaping', () => {
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize('line\nbreak')).toBe('"line\\nbreak"');
  });

  it('serializes unicode strings the same way JSON.stringify does', () => {
    const s = 'café — 日本語 — 🦞';
    expect(canonicalize(s)).toBe(JSON.stringify(s));
  });
});

describe('canonicalize — deterministic object key ordering', () => {
  it('produces the SAME string regardless of key insertion order', () => {
    const a = { alpha: 1, beta: 2, gamma: 3 };
    const b = { gamma: 3, beta: 2, alpha: 1 };
    const c = { beta: 2, gamma: 3, alpha: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(b)).toBe(canonicalize(c));
  });

  it('sorts keys ascending and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('serializes an empty object', () => {
    expect(canonicalize({})).toBe('{}');
  });
});

describe('canonicalize — nested structures', () => {
  it('recurses through nested objects with stable ordering', () => {
    const x = { outer: { z: 1, a: 2 }, first: [3, 2, 1] };
    const y = { first: [3, 2, 1], outer: { a: 2, z: 1 } };
    expect(canonicalize(x)).toBe(canonicalize(y));
    expect(canonicalize(x)).toBe('{"first":[3,2,1],"outer":{"a":2,"z":1}}');
  });

  it('serializes arrays preserving element order (arrays are NOT sorted)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([])).toBe('[]');
  });

  it('handles arrays of mixed primitives and nested objects', () => {
    const v = [1, 'two', true, null, { k: 'v' }];
    expect(canonicalize(v)).toBe('[1,"two",true,null,{"k":"v"}]');
  });
});

describe('canonicalize — equality vs difference', () => {
  it('canonicalizes two semantically-equal envelopes identically', () => {
    const env1 = {
      version: 1,
      eventType: 'member.join',
      payload: { userId: 'u1', roles: ['a', 'b'] },
      nonce: 'abc',
    };
    const env2 = {
      nonce: 'abc',
      payload: { roles: ['a', 'b'], userId: 'u1' },
      eventType: 'member.join',
      version: 1,
    };
    expect(canonicalize(env1)).toBe(canonicalize(env2));
  });

  it('canonicalizes semantically-different inputs differently', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
    // Array order is significant.
    expect(canonicalize(['a', 'b'])).not.toBe(canonicalize(['b', 'a']));
  });
});

describe('canonicalize — undefined handling (documented subtle contract)', () => {
  it('OMITS object properties whose value is undefined', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('treats an omitted optional field the same as an explicit-undefined one', () => {
    const withUndef = { a: 1, optional: undefined };
    const without = { a: 1 };
    expect(canonicalize(withUndef)).toBe(canonicalize(without));
  });

  it('REPLACES undefined inside an array with null', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
  });
});

describe('canonicalize — type guards', () => {
  it('throws on a top-level undefined value', () => {
    expect(() => canonicalize(undefined)).toThrow(TypeError);
    expect(() => canonicalize(undefined)).toThrow(/top-level value cannot be undefined/);
  });

  it('throws on NaN', () => {
    expect(() => canonicalize(NaN)).toThrow(/non-finite number/);
  });

  it('throws on Infinity and -Infinity', () => {
    expect(() => canonicalize(Infinity)).toThrow(/non-finite number/);
    expect(() => canonicalize(-Infinity)).toThrow(/non-finite number/);
  });

  it('throws on a non-finite number nested inside an object', () => {
    expect(() => canonicalize({ score: NaN })).toThrow(/non-finite number/);
  });

  it('throws on an unsupported type (bigint)', () => {
    expect(() => canonicalize(10n)).toThrow(/unsupported type bigint/);
  });

  it('throws on an unsupported type (function)', () => {
    expect(() => canonicalize(() => 1)).toThrow(/unsupported type function/);
  });

  it('throws on an unsupported type (symbol)', () => {
    expect(() => canonicalize(Symbol('x'))).toThrow(/unsupported type symbol/);
  });
});
