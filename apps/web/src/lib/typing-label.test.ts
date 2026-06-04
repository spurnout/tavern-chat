import { describe, it, expect } from 'vitest';
import { typingLabel } from './typing-label.js';

describe('typingLabel', () => {
  it('returns null when nobody else is typing', () => {
    expect(typingLabel(0)).toBeNull();
    expect(typingLabel(-1)).toBeNull();
  });

  it('names nobody — one typer reads as "Someone"', () => {
    expect(typingLabel(1)).toBe('Someone is typing…');
  });

  it('two typers read as "Two people"', () => {
    expect(typingLabel(2)).toBe('Two people are typing…');
  });

  it('three or more typers use a numeric count', () => {
    expect(typingLabel(3)).toBe('3 people are typing…');
    expect(typingLabel(12)).toBe('12 people are typing…');
  });

  it('never leaks a raw identifier into the label', () => {
    for (let n = 1; n <= 5; n++) {
      expect(typingLabel(n)).not.toMatch(/[0-9a-f]{8}/i);
    }
  });
});
