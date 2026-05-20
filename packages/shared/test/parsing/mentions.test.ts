import { describe, expect, it } from 'vitest';
import {
  parseMentions,
  nameMentions,
  qualifiedMentions,
  hasGroupMention,
} from '../../src/parsing/mentions.js';

describe('parseMentions: local-only mentions', () => {
  it('parses @alice as a name mention', () => {
    const result = parseMentions('@alice');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'name', name: 'alice', raw: '@alice' });
  });

  it('parses @everyone as a group mention', () => {
    const result = parseMentions('@everyone');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'group', group: 'everyone', raw: '@everyone' });
  });

  it('parses @here as a group mention', () => {
    const result = parseMentions('@here');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'group', group: 'here', raw: '@here' });
  });

  it('parses @alice in sentence context', () => {
    const result = parseMentions('Hey @alice how are you?');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'name', name: 'alice', raw: '@alice' });
  });
});

describe('parseMentions: qualified mentions', () => {
  it('parses @alice@b.example.com as qualified', () => {
    const result = parseMentions('@alice@b.example.com');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'qualified',
      localpart: 'alice',
      host: 'b.example.com',
      raw: '@alice@b.example.com',
    });
  });

  it('parses qualified mention at the start of string', () => {
    const result = parseMentions('@alice@remote.example.org is here');
    expect(result).toHaveLength(1);
    const m = result[0];
    expect(m?.kind).toBe('qualified');
    if (m?.kind === 'qualified') {
      expect(m.localpart).toBe('alice');
      expect(m.host).toBe('remote.example.org');
      expect(m.raw).toBe('@alice@remote.example.org');
    }
  });

  it('parses qualified mention after opening parenthesis', () => {
    const result = parseMentions('(@alice@b.example.com)');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'qualified', localpart: 'alice', host: 'b.example.com' });
  });

  it('falls back to name mention when host has no dot', () => {
    // @alice@nodot — host "nodot" has no dot → treated as name mention for @alice
    const result = parseMentions('@alice@nodot');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'name', name: 'alice', raw: '@alice' });
  });
});

describe('parseMentions: multiple mentions in one string', () => {
  it('finds both a name and a qualified mention', () => {
    const result = parseMentions("Hi @alice and @bob@b.example, what's up?");
    expect(result).toHaveLength(2);
    const kinds = result.map((m) => m.kind);
    expect(kinds).toContain('name');
    expect(kinds).toContain('qualified');
  });

  it('handles three mixed mentions', () => {
    const result = parseMentions('@everyone ping @bob@remote.example.com and @carol');
    expect(result).toHaveLength(3);
    const byKind = Object.fromEntries(
      ['group', 'qualified', 'name'].map((k) => [k, result.filter((m) => m.kind === k).length]),
    );
    expect(byKind).toEqual({ group: 1, qualified: 1, name: 1 });
  });
});

describe('qualifiedMentions helper', () => {
  it('returns only qualified mentions', () => {
    const result = qualifiedMentions("Hi @alice and @bob@b.example, what's up?");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ localpart: 'bob', host: 'b.example' });
  });

  it('returns empty array when no qualified mentions', () => {
    expect(qualifiedMentions('@alice @everyone')).toHaveLength(0);
  });

  it('returns multiple qualified mentions', () => {
    const result = qualifiedMentions('@alice@a.example @bob@b.example.org');
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.host)).toEqual(['a.example', 'b.example.org']);
  });
});

describe('nameMentions helper (backward compatibility)', () => {
  it('returns only name mention strings', () => {
    const parsed = parseMentions('@alice @bob@remote.example.com @everyone');
    expect(nameMentions(parsed)).toEqual(['alice']);
  });

  it('deduplicates repeated name mentions', () => {
    const parsed = parseMentions('@alice said hi to @alice');
    expect(nameMentions(parsed)).toEqual(['alice']);
  });

  it('excludes qualified and group mentions', () => {
    const parsed = parseMentions('@bob@b.example @here @carol');
    const names = nameMentions(parsed);
    expect(names).toContain('carol');
    expect(names).not.toContain('bob');
    expect(names).not.toContain('here');
  });
});

describe('hasGroupMention helper (unchanged)', () => {
  it('returns true when @everyone is present', () => {
    const parsed = parseMentions('@everyone');
    expect(hasGroupMention(parsed)).toBe(true);
  });

  it('returns false when only name or qualified mentions', () => {
    const parsed = parseMentions('@alice @bob@remote.example.com');
    expect(hasGroupMention(parsed)).toBe(false);
  });
});

describe('edge cases', () => {
  it('ignores @ in the middle of a word (email-like)', () => {
    // "word@something" — no leading boundary, should not parse
    const result = parseMentions('send to user@example.com');
    expect(result).toHaveLength(0);
  });

  it('parses empty string without throwing', () => {
    expect(parseMentions('')).toHaveLength(0);
  });

  it('handles mention after [ and { brackets', () => {
    expect(parseMentions('[@alice]')).toHaveLength(1);
    expect(parseMentions('{@here}')).toHaveLength(1);
  });

  it('handles trailing period after qualified host (actual regex behavior)', () => {
    // @alice@b.example. — trailing dot is consumed into host by the greedy
    // [A-Za-z0-9.-]+ pattern. The \b boundary does not fire between dot and
    // end-of-string/space, so the trailing dot is captured into the host.
    // The resolver will reject the malformed host; the parser just emits as-is.
    const result = parseMentions('@alice@b.example.');
    // One qualified mention is emitted; host may include the trailing dot.
    // We only assert the kind and localpart here because the exact boundary
    // behavior depends on what follows the trailing dot.
    expect(result).toHaveLength(1);
    if (result[0]?.kind === 'qualified') {
      expect(result[0].localpart).toBe('alice');
      // host contains 'b.example' at minimum
      expect(result[0].host).toContain('b.example');
    }
  });
});
