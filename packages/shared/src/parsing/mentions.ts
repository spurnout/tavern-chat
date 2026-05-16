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
 *
 * The parser treats `@` only when it follows whitespace or the start of the
 * string so that emails / file paths / handles in the middle of a word are
 * not picked up.
 */

export type ParsedMention =
  | { kind: 'group'; group: 'everyone' | 'here'; raw: string }
  | { kind: 'name'; name: string; raw: string };

const MENTION_REGEX = /(?:^|[\s(\[{])@([A-Za-z0-9_\-.]+)\b/g;

export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(MENTION_REGEX)) {
    const name = m[1];
    if (!name) continue;
    if (name === 'everyone' || name === 'here') {
      out.push({ kind: 'group', group: name, raw: `@${name}` });
    } else {
      out.push({ kind: 'name', name, raw: `@${name}` });
    }
  }
  return out;
}

/** True if `parsed` contains any @everyone or @here. */
export function hasGroupMention(parsed: ReadonlyArray<ParsedMention>): boolean {
  return parsed.some((m) => m.kind === 'group');
}

/** Just the unique `@<name>` strings (user or role candidates). */
export function nameMentions(parsed: ReadonlyArray<ParsedMention>): string[] {
  const seen = new Set<string>();
  for (const m of parsed) {
    if (m.kind === 'name') seen.add(m.name);
  }
  return Array.from(seen);
}
