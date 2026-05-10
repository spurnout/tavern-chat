/**
 * Safe dice notation parser and evaluator.
 *
 * Grammar (simplified):
 *
 *   roll       := term ( ("+" | "-") term )*
 *   term       := dice | integer
 *   dice       := count? "d" faces keep?
 *   keep       := ("kh" | "kl") integer
 *   count      := integer (1..MAX)
 *   faces      := integer (1..MAX) | "%"  (% means d100)
 *
 *   "d6"           -> 1d6
 *   "1d20"         -> single d20
 *   "1d20+5"       -> d20 plus modifier
 *   "2d6"          -> two d6 summed
 *   "4d6kh3"       -> roll 4d6, keep highest 3
 *   "2d20kl1"      -> roll 2d20, keep lowest 1 (disadvantage)
 *   "d%"           -> 1d100
 *
 * Implementation notes:
 *   - Hand-written tokenizer + recursive-descent parser (no eval, no regex tricks).
 *   - All randomness is injected via the rng parameter so tests are deterministic.
 *   - Limits: MAX_DICE_PER_ROLL, MAX_FACES, MAX_NOTATION_LENGTH (see constants).
 */

import { DICE_LIMITS } from './constants.js';
import type { DiceRollResult, DiceTermResult, DieResult } from './schemas/dice.js';

export class DiceParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
    this.name = 'DiceParseError';
  }
}

interface ParsedDiceTerm {
  kind: 'dice';
  count: number;
  faces: number;
  keep: { mode: 'kh' | 'kl'; amount: number } | null;
  sign: 1 | -1;
}

interface ParsedModifierTerm {
  kind: 'modifier';
  value: number;
  sign: 1 | -1;
}

type ParsedTerm = ParsedDiceTerm | ParsedModifierTerm;

interface ParsedRoll {
  notation: string;
  terms: ParsedTerm[];
}

class Tokenizer {
  private pos = 0;
  constructor(private readonly input: string) {}

  peek(): string | null {
    return this.pos < this.input.length ? (this.input[this.pos] as string) : null;
  }

  consume(): string {
    if (this.pos >= this.input.length) {
      throw new DiceParseError('Unexpected end of input', this.pos);
    }
    const ch = this.input[this.pos] as string;
    this.pos++;
    return ch;
  }

  /** Match a literal at the current position; on success, advance. */
  match(literal: string): boolean {
    const lower = this.input.slice(this.pos, this.pos + literal.length).toLowerCase();
    if (lower === literal.toLowerCase()) {
      this.pos += literal.length;
      return true;
    }
    return false;
  }

  skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos] as string)) {
      this.pos++;
    }
  }

  readInteger(): number | null {
    this.skipWhitespace();
    let start = this.pos;
    while (this.pos < this.input.length && /[0-9]/.test(this.input[this.pos] as string)) {
      this.pos++;
    }
    if (this.pos === start) return null;
    const slice = this.input.slice(start, this.pos);
    return Number.parseInt(slice, 10);
  }

  position(): number {
    return this.pos;
  }
}

export function parseDiceNotation(notation: string): ParsedRoll {
  if (typeof notation !== 'string') {
    throw new DiceParseError('Notation must be a string', 0);
  }
  const trimmed = notation.trim();
  if (trimmed.length === 0) {
    throw new DiceParseError('Empty notation', 0);
  }
  if (trimmed.length > DICE_LIMITS.MAX_NOTATION_LENGTH) {
    throw new DiceParseError(
      `Notation exceeds ${DICE_LIMITS.MAX_NOTATION_LENGTH} characters`,
      0,
    );
  }

  const t = new Tokenizer(trimmed);
  const terms: ParsedTerm[] = [];
  let totalDice = 0;

  // First term may have an explicit "+" or "-"; default sign is "+".
  let sign: 1 | -1 = 1;
  t.skipWhitespace();
  if (t.peek() === '+' || t.peek() === '-') {
    sign = t.consume() === '-' ? -1 : 1;
  }

  while (true) {
    t.skipWhitespace();
    const term = parseTerm(t, sign);
    if (term.kind === 'dice') {
      totalDice += term.count;
      if (totalDice > DICE_LIMITS.MAX_DICE_PER_ROLL) {
        throw new DiceParseError(
          `Total dice exceeds ${DICE_LIMITS.MAX_DICE_PER_ROLL}`,
          t.position(),
        );
      }
    }
    terms.push(term);
    t.skipWhitespace();

    const next = t.peek();
    if (next === null) break;
    if (next !== '+' && next !== '-') {
      throw new DiceParseError(`Unexpected character "${next}"`, t.position());
    }
    sign = t.consume() === '-' ? -1 : 1;
  }

  if (terms.length === 0) {
    throw new DiceParseError('No terms in notation', 0);
  }

  return { notation: trimmed, terms };
}

function parseTerm(t: Tokenizer, sign: 1 | -1): ParsedTerm {
  // A term either starts with an integer (then optionally "d...") or with "d...".
  let count: number | null = null;
  if (t.peek() !== 'd' && t.peek() !== 'D') {
    count = t.readInteger();
    if (count === null) {
      throw new DiceParseError('Expected integer or "d"', t.position());
    }
  }

  // Pure integer term?
  const next = t.peek();
  if (next !== 'd' && next !== 'D') {
    if (count === null) {
      throw new DiceParseError('Expected integer', t.position());
    }
    return { kind: 'modifier', value: count, sign };
  }

  // Otherwise it's a dice term.
  t.consume(); // consume 'd'

  let faces: number;
  if (t.peek() === '%') {
    t.consume();
    faces = 100;
  } else {
    const f = t.readInteger();
    if (f === null) {
      throw new DiceParseError('Expected face count after "d"', t.position());
    }
    faces = f;
  }

  if (count === null) count = 1;
  if (count <= 0 || count > DICE_LIMITS.MAX_DICE_PER_ROLL) {
    throw new DiceParseError(
      `Dice count must be between 1 and ${DICE_LIMITS.MAX_DICE_PER_ROLL}`,
      t.position(),
    );
  }
  if (faces <= 0 || faces > DICE_LIMITS.MAX_FACES) {
    throw new DiceParseError(`Faces must be between 1 and ${DICE_LIMITS.MAX_FACES}`, t.position());
  }

  let keep: ParsedDiceTerm['keep'] = null;
  if (t.match('kh')) {
    const amount = t.readInteger();
    if (amount === null || amount <= 0) {
      throw new DiceParseError('Expected positive integer after "kh"', t.position());
    }
    if (amount > count) {
      throw new DiceParseError('Keep amount exceeds dice count', t.position());
    }
    keep = { mode: 'kh', amount };
  } else if (t.match('kl')) {
    const amount = t.readInteger();
    if (amount === null || amount <= 0) {
      throw new DiceParseError('Expected positive integer after "kl"', t.position());
    }
    if (amount > count) {
      throw new DiceParseError('Keep amount exceeds dice count', t.position());
    }
    keep = { mode: 'kl', amount };
  }

  return { kind: 'dice', count, faces, keep, sign };
}

// ---- Evaluation ------------------------------------------------------------

/** Returns a uniformly random integer in [1, max]. */
export type DiceRng = (max: number) => number;

export function defaultRng(max: number): number {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return ((buf[0] as number) % max) + 1;
  }
  return Math.floor(Math.random() * max) + 1;
}

export function evaluateDiceNotation(notation: string, rng: DiceRng = defaultRng): DiceRollResult {
  const parsed = parseDiceNotation(notation);
  const terms: DiceTermResult[] = [];
  let total = 0;

  for (const term of parsed.terms) {
    if (term.kind === 'modifier') {
      const subtotal = term.sign * term.value;
      total += subtotal;
      terms.push({
        kind: 'modifier',
        value: term.value,
        sign: term.sign,
        subtotal,
      });
      continue;
    }

    const rolls: DieResult[] = [];
    for (let i = 0; i < term.count; i++) {
      rolls.push({ value: rng(term.faces), kept: true });
    }

    if (term.keep) {
      const indexed = rolls.map((r, i) => ({ ...r, i }));
      indexed.sort((a, b) =>
        term.keep!.mode === 'kh' ? b.value - a.value : a.value - b.value,
      );
      const keepIndices = new Set(indexed.slice(0, term.keep.amount).map((r) => r.i));
      for (let i = 0; i < rolls.length; i++) {
        const roll = rolls[i];
        if (roll) roll.kept = keepIndices.has(i);
      }
    }

    const kept = rolls.filter((r) => r.kept).reduce((sum, r) => sum + r.value, 0);
    const subtotal = term.sign * kept;
    total += subtotal;

    terms.push({
      kind: 'dice',
      count: term.count,
      faces: term.faces,
      keep: term.keep,
      rolls,
      sign: term.sign,
      subtotal,
    });
  }

  return { notation: parsed.notation, terms, total };
}
