import { describe, expect, it } from 'vitest';
import { parseChannelMentions } from '../../src/parsing/channel-mentions.js';

describe('parseChannelMentions', () => {
  it('parses a single #channel at the start of the string', () => {
    expect(parseChannelMentions('#general hello')).toEqual([{ raw: '#general', name: 'general' }]);
  });

  it('parses mentions after whitespace and opening brackets', () => {
    expect(parseChannelMentions('see #rules and (#faq) or [#help] or {#meta}')).toEqual([
      { raw: '#rules', name: 'rules' },
      { raw: '#faq', name: 'faq' },
      { raw: '#help', name: 'help' },
      { raw: '#meta', name: 'meta' },
    ]);
  });

  it('allows hyphens, underscores, dots, and digits in the name', () => {
    expect(parseChannelMentions('#board-games_2.0')).toEqual([
      { raw: '#board-games_2.0', name: 'board-games_2.0' },
    ]);
  });

  it('does NOT match a URL hash fragment', () => {
    expect(parseChannelMentions('visit https://example.com/#anchor now')).toEqual([]);
  });

  it('does NOT match a # glued to a preceding word character', () => {
    expect(parseChannelMentions('foo#bar')).toEqual([]);
  });

  it('returns an empty array when there are no channel mentions', () => {
    expect(parseChannelMentions('just some plain text')).toEqual([]);
  });

  it('parses multiple distinct mentions across the string', () => {
    expect(parseChannelMentions('#a then #b then #c').map((m) => m.name)).toEqual(['a', 'b', 'c']);
  });
});
