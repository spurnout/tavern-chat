/**
 * Wave 3 #2 — channel mentions (`#room-name`).
 *
 * The parser pulls out `#word` tokens that follow whitespace / bracket /
 * start of string, so a URL hash like `https://example.com/#anchor` won't
 * be picked up. The client resolves names against `channelsByServer` at
 * render time to produce clickable pills.
 */

export interface ParsedChannelMention {
  /** The raw token `#name` as it appears in the source text. */
  raw: string;
  /** The bare channel name without the `#`. */
  name: string;
}

const CHANNEL_MENTION_REGEX = /(?:^|[\s(\[{])#([A-Za-z0-9_\-.]+)\b/g;

export function parseChannelMentions(text: string): ParsedChannelMention[] {
  const out: ParsedChannelMention[] = [];
  for (const m of text.matchAll(CHANNEL_MENTION_REGEX)) {
    const name = m[1];
    if (!name) continue;
    out.push({ raw: `#${name}`, name });
  }
  return out;
}
