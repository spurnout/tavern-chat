import { describe, expect, it } from 'vitest';
import { parseInlineSegments } from './markdown.js';

const link = (url: string) => ({ kind: 'link', href: url, label: url });

describe('parseInlineSegments — URLs containing marker characters', () => {
  it('keeps an underscored URL intact instead of splitting it into italics', () => {
    // Steam puts underscores between title words; the parser must not treat
    // them as `_italic_` delimiters and truncate the link.
    const url = 'https://store.steampowered.com/app/1162750/Songs_of_Syx/';
    expect(parseInlineSegments(url)).toEqual([link(url)]);
  });

  it('keeps asterisks inside a URL from becoming italics', () => {
    const url = 'https://example.com/a*b*c';
    expect(parseInlineSegments(url)).toEqual([link(url)]);
  });

  it('links a URL embedded in surrounding prose', () => {
    expect(parseInlineSegments('pull up a chair at https://example.com/a_b_c yeah')).toEqual([
      { kind: 'text', value: 'pull up a chair at ' },
      link('https://example.com/a_b_c'),
      { kind: 'text', value: ' yeah' },
    ]);
  });

  it('still resolves a mention that follows a URL', () => {
    expect(parseInlineSegments('https://example.com/a_b @goat')).toEqual([
      link('https://example.com/a_b'),
      { kind: 'text', value: ' ' },
      { kind: 'mention', raw: '@goat' },
    ]);
  });

  it('leaves emphasis working in ordinary text (no over-broadening)', () => {
    expect(parseInlineSegments('that was _so_ good')).toEqual([
      { kind: 'text', value: 'that was ' },
      { kind: 'italic', value: 'so' },
      { kind: 'text', value: ' good' },
    ]);
  });

  it('does not autolink an http(s) run glued to a preceding word', () => {
    // Mirrors URL_RE's `\b`: `xhttps://…` was never linked, and still isn't.
    expect(parseInlineSegments('xhttps://example.com/a')).toEqual([
      { kind: 'text', value: 'xhttps://example.com/a' },
    ]);
  });
});
