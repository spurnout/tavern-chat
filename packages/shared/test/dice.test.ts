import { describe, expect, it } from 'vitest';
import {
  DiceParseError,
  evaluateDiceNotation,
  parseDiceNotation,
  type DiceRng,
} from '../src/dice.js';

/** Deterministic RNG that returns the next value from a queue, modulo `max`. */
function fakeRng(queue: number[]): DiceRng {
  let i = 0;
  return (max: number) => {
    const v = queue[i++];
    if (v === undefined) throw new Error('Ran out of fake rolls');
    return ((v - 1) % max) + 1;
  };
}

describe('dice: parser', () => {
  it('accepts plain integers as modifier terms', () => {
    const r = parseDiceNotation('5');
    expect(r.terms).toHaveLength(1);
    expect(r.terms[0]).toMatchObject({ kind: 'modifier', value: 5, sign: 1 });
  });

  it('accepts a bare "d6" as 1d6', () => {
    const r = parseDiceNotation('d6');
    const term = r.terms[0];
    expect(term?.kind).toBe('dice');
    if (term?.kind === 'dice') {
      expect(term.count).toBe(1);
      expect(term.faces).toBe(6);
    }
  });

  it('accepts "d%" as 1d100', () => {
    const r = parseDiceNotation('d%');
    const term = r.terms[0];
    if (term?.kind === 'dice') {
      expect(term.faces).toBe(100);
    } else {
      expect.fail('expected dice term');
    }
  });

  it('parses "4d6kh3" with keep-highest-3', () => {
    const r = parseDiceNotation('4d6kh3');
    const term = r.terms[0];
    if (term?.kind !== 'dice') {
      expect.fail('expected dice term');
      return;
    }
    expect(term.count).toBe(4);
    expect(term.faces).toBe(6);
    expect(term.keep).toEqual({ mode: 'kh', amount: 3 });
  });

  it('parses "2d20kl1" (disadvantage)', () => {
    const r = parseDiceNotation('2d20kl1');
    const term = r.terms[0];
    if (term?.kind !== 'dice') {
      expect.fail('expected dice term');
      return;
    }
    expect(term.keep).toEqual({ mode: 'kl', amount: 1 });
  });

  it('parses "1d20+5"', () => {
    const r = parseDiceNotation('1d20+5');
    expect(r.terms).toHaveLength(2);
    expect(r.terms[1]).toMatchObject({ kind: 'modifier', value: 5, sign: 1 });
  });

  it('parses "2d6 - 3"', () => {
    const r = parseDiceNotation('2d6 - 3');
    expect(r.terms[1]).toMatchObject({ kind: 'modifier', value: 3, sign: -1 });
  });

  it('rejects empty input', () => {
    expect(() => parseDiceNotation('')).toThrow(DiceParseError);
  });

  it('rejects garbage', () => {
    expect(() => parseDiceNotation('hello')).toThrow(DiceParseError);
    expect(() => parseDiceNotation('1d')).toThrow(DiceParseError);
    expect(() => parseDiceNotation('d')).toThrow(DiceParseError);
  });

  it('rejects keep amount greater than count', () => {
    expect(() => parseDiceNotation('2d6kh3')).toThrow(DiceParseError);
  });

  it('caps total dice', () => {
    expect(() => parseDiceNotation('200d6')).toThrow(DiceParseError);
  });

  it('caps faces', () => {
    expect(() => parseDiceNotation('1d100000')).toThrow(DiceParseError);
  });

  it('does not call eval, function, or any global accessor', () => {
    // No mock needed: parser is pure string traversal. The presence of these
    // tokens in input must not cause execution.
    const tricky = '1d20+5'; // baseline
    expect(() => parseDiceNotation(tricky)).not.toThrow();
    expect(() => parseDiceNotation('eval(1)')).toThrow(DiceParseError);
    expect(() => parseDiceNotation('Function("a")()')).toThrow(DiceParseError);
  });
});

describe('dice: evaluator', () => {
  it('sums simple 2d6 rolls', () => {
    const result = evaluateDiceNotation('2d6', fakeRng([3, 5]));
    expect(result.total).toBe(8);
    const term = result.terms[0];
    if (term?.kind !== 'dice') {
      expect.fail('expected dice term');
      return;
    }
    expect(term.rolls.map((r) => r.value)).toEqual([3, 5]);
    expect(term.rolls.every((r) => r.kept)).toBe(true);
  });

  it('keeps highest 3 of 4d6', () => {
    const result = evaluateDiceNotation('4d6kh3', fakeRng([1, 6, 4, 5]));
    const term = result.terms[0];
    if (term?.kind !== 'dice') {
      expect.fail('expected dice term');
      return;
    }
    const kept = term.rolls.filter((r) => r.kept).map((r) => r.value).sort();
    expect(kept).toEqual([4, 5, 6]);
    expect(result.total).toBe(15);
  });

  it('keeps lowest 1 of 2d20 (disadvantage)', () => {
    const result = evaluateDiceNotation('2d20kl1', fakeRng([18, 4]));
    expect(result.total).toBe(4);
  });

  it('applies modifiers and signs correctly', () => {
    const result = evaluateDiceNotation('1d20+5-2', fakeRng([10]));
    expect(result.total).toBe(13);
    expect(result.terms.length).toBe(3);
  });

  it('handles negation on dice terms', () => {
    const result = evaluateDiceNotation('10-1d6', fakeRng([4]));
    expect(result.total).toBe(6);
  });

  it('roundtrip: result.notation reflects the trimmed input', () => {
    const result = evaluateDiceNotation('  1d20+5  ', fakeRng([10]));
    expect(result.notation).toBe('1d20+5');
  });
});
