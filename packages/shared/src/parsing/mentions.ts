/**
 * Mention parsing.
 *
 * Tavern stores raw message text and lets the client render mentions by
 * matching against the visible members + roles. The server uses this same
 * parser to gate `@everyone` / `@here` / `@<role>` against permissions
 * before persisting a message.
 *
 * Recognized forms:
 *   @everyone               → group mention, everyone in the channel
 *   @here                   → group mention, online members only
 *   @<word>                 → user OR role, resolved by name on the server
 *   @<word>@<host>          → qualified federation mention (Phase 2)
 *
 * The parser treats `@` only when it follows whitespace or the start of the
 * string so that emails / file paths / handles in the middle of a word are
 * not picked up.
 *
 * Qualified-mention edge cases:
 *   - The host must contain at least one dot to be treated as qualified.
 *     `@alice@nodot` → name mention `@alice`; the trailing `@nodot` is left
 *     as literal text in the message body.
 *   - Trailing punctuation (e.g. `@alice@b.example.`) may be consumed into
 *     the host by the greedy `[A-Za-z0-9.-]+` pattern. The resolver in P2-9
 *     is responsible for rejecting malformed hosts; the parser emits as-is.
 */

export type ParsedMention =
  | { kind: 'group'; group: 'everyone' | 'here'; raw: string }
  | { kind: 'name'; name: string; raw: string }
  | { kind: 'qualified'; localpart: string; host: string; raw: string };

/**
 * Matches an optional `@<host>` suffix after the localpart.
 * Group 1 = localpart, Group 2 = host (may be undefined).
 *
 * The `\b` word boundary at the end fires between the last char of the
 * localpart/host and whatever follows. For a host ending with a letter or
 * digit this works as expected; for a host ending with a dot or hyphen the
 * boundary may not fire and the trailing punctuation is consumed into the
 * match — see the edge-case note above.
 */
export const MENTION_REGEX = /(?:^|[\s(\[{])@([A-Za-z0-9_\-.]+)(?:@([A-Za-z0-9.-]+))?\b/g;

export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(MENTION_REGEX)) {
    const localpart = m[1];
    if (!localpart) continue;

    const host = m[2];
    const fullMatch = m[0];
    // The leading character (space/bracket/start) is not part of the mention.
    const lead = /^[\s(\[{]/.test(fullMatch) ? 1 : 0;

    if (host && host.includes('.')) {
      // Qualified federation mention: @localpart@host
      const raw = fullMatch.slice(lead);
      out.push({ kind: 'qualified', localpart, host, raw });
      continue;
    }

    // Plain local mention (host absent or no dot → ignore host text, fall back
    // to treating only the localpart as the mention).
    if (localpart === 'everyone' || localpart === 'here') {
      out.push({ kind: 'group', group: localpart, raw: `@${localpart}` });
    } else {
      out.push({ kind: 'name', name: localpart, raw: `@${localpart}` });
    }
  }
  return out;
}

/** True if `parsed` contains any @everyone or @here. */
export function hasGroupMention(parsed: ReadonlyArray<ParsedMention>): boolean {
  return parsed.some((m) => m.kind === 'group');
}

/** Just the unique `@<name>` strings (user or role candidates). Excludes qualified mentions. */
export function nameMentions(parsed: ReadonlyArray<ParsedMention>): string[] {
  const seen = new Set<string>();
  for (const m of parsed) {
    if (m.kind === 'name') seen.add(m.name);
  }
  return Array.from(seen);
}

/**
 * Return unique `{ localpart, host }` pairs for all qualified mentions.
 * Used by the federation mention resolver (P2-9) to enumerate remote users.
 */
export function qualifiedMentions(
  text: string,
): Array<{ localpart: string; host: string }> {
  return parseMentions(text)
    .filter((m): m is Extract<ParsedMention, { kind: 'qualified' }> => m.kind === 'qualified')
    .map((m) => ({ localpart: m.localpart, host: m.host }));
}
