/**
 * Minimal in-house markdown parser for Tavern message bodies.
 *
 * Goals:
 *   - No HTML strings, no dangerouslySetInnerHTML. The parser emits a typed
 *     segment tree and the renderer maps each segment to a React node.
 *   - Single-pass, line-based, deterministic. Inline-only formatting inside
 *     a single line; block constructs (fenced code, blockquote) handled by a
 *     line-level pre-scan.
 *   - Covers the 95% of marker-flavored markdown people use in chat: bold,
 *     italic, strikethrough, inline code, fenced code, spoilers, blockquotes,
 *     URLs, and @mentions.
 *
 * Tradeoffs:
 *   - No nested inline formatting (bold-inside-italic, etc). Keeps the parser
 *     compact and predictable.
 *   - No headings. Chat messages with `#` headings are unusual and surprise
 *     users when they auto-format.
 *   - Custom-emoji shortcodes (`:emoji-name:`) are recognized but rendered as
 *     plain text for now — wiring server custom-emoji into the segment is a
 *     follow-up.
 */

import { MENTION_REGEX } from '@tavern/shared';

export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'strike'; value: string }
  | { kind: 'spoiler'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'mention'; raw: string }
  | { kind: 'channel-mention'; raw: string; name: string }
  /** Wave 3 #21 — `[[Page Name]]` or `[[Page Name|display label]]`. */
  | { kind: 'wikilink'; target: string; label: string }
  /** IR20 Phase 2 — `@localpart@host.example` federated mention. */
  | { kind: 'qualifiedMention'; raw: string; localpart: string; host: string };

export type Block =
  | { kind: 'paragraph'; segments: Segment[] }
  | { kind: 'codeblock'; language: string | null; value: string }
  | { kind: 'blockquote'; segments: Segment[] };

/**
 * URL detector. Conservative — won't match bare domains, only `http(s)://...`.
 * Sticky so the inline tokenizer can consume a URL straight from the cursor,
 * *before* the emphasis branches. That ordering is what keeps marker characters
 * inside a URL (`_`, `*`, `~`, `|`) from being read as formatting and splitting
 * the link (e.g. `.../Songs_of_Syx/`). A leading `\b` is reproduced at the
 * call-site with a preceding-word-char guard.
 */
const URL_AT_RE = /https?:\/\/[^\s<>()\[\]]+/y;

/** Word-character test matching JS `\b` semantics (`[A-Za-z0-9_]`). */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Mention regex — re-exported from `@tavern/shared` (MENTION_REGEX). Uses a
 * non-capturing lead group `(?:^|[\s(\[{])` so group 1 = localpart and
 * group 2 = optional host. The lead offset is recovered from `m[0]` at
 * call-sites when needed.
 */

/** Channel mention regex — `#room-name` after whitespace/bracket/start. */
const CHANNEL_RE = /(^|[\s(\[{])#([A-Za-z0-9_\-.]+)/g;

export function parseMarkdownBlocks(input: string): Block[] {
  if (!input) return [];
  const lines = input.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code block `` ``` `` (optional language tag on the opener).
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] || null;
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== undefined && !/^```\s*$/.test(lines[i] as string)) {
        buf.push(lines[i] as string);
        i += 1;
      }
      // Skip the closer (or accept unterminated at EOF).
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'codeblock', language, value: buf.join('\n') });
      continue;
    }
    // Blockquote — consecutive `>` lines collapse into one block.
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [line.replace(/^\s*>\s?/, '')];
      i += 1;
      while (i < lines.length && /^\s*>\s?/.test(lines[i] as string)) {
        buf.push((lines[i] as string).replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', segments: parseInlineSegments(buf.join('\n')) });
      continue;
    }
    // Paragraph — gather contiguous non-blank lines.
    if (line.trim().length === 0) {
      blocks.push({ kind: 'paragraph', segments: [{ kind: 'text', value: '' }] });
      i += 1;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      (lines[i] as string).trim().length > 0 &&
      !/^```/.test(lines[i] as string) &&
      !/^\s*>\s?/.test(lines[i] as string)
    ) {
      para.push(lines[i] as string);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', segments: parseInlineSegments(para.join('\n')) });
  }
  return blocks;
}

/**
 * Single-pass inline tokenizer. Each marker captures a non-greedy span until
 * its closer; unmatched markers fall through as literal text so a stray `*`
 * doesn't eat the rest of the message.
 */
export function parseInlineSegments(input: string): Segment[] {
  if (!input) return [];
  const out: Segment[] = [];
  let i = 0;
  let textBuf = '';

  function flushText(): void {
    if (textBuf.length === 0) return;
    // Resolve @mentions and #channel-mentions in the accumulated plain text.
    // (URLs are already tokenized atomically in the main loop above.)
    const subSegments = splitOnMentions(textBuf);
    for (const s of subSegments) out.push(s);
    textBuf = '';
  }

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    // Autolink URLs as a single atom *before* any emphasis branch, so marker
    // characters inside the URL (`_`, `*`, `~`, `|`) are never interpreted as
    // formatting. Gated on `h` plus a non-word preceding char to mirror
    // URL_RE's `\b`; a URL glued to a preceding word stays literal, as before.
    // (Code spans still win: a backtick opener is consumed by the branch below
    // before its inner `h` is ever reached.)
    if (ch === 'h' && !isWordChar(input[i - 1])) {
      URL_AT_RE.lastIndex = i;
      const m = URL_AT_RE.exec(input);
      if (m) {
        flushText();
        out.push({ kind: 'link', href: m[0], label: m[0] });
        i = URL_AT_RE.lastIndex;
        continue;
      }
    }
    // Inline code: `code`
    if (ch === '`') {
      const close = input.indexOf('`', i + 1);
      if (close > i) {
        flushText();
        out.push({ kind: 'code', value: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    // Wikilink: [[Page Name]] or [[Page Name|display label]]. Tested before
    // the spoiler/strike branches because `[[` is unambiguous.
    if (ch === '[' && next === '[') {
      const close = input.indexOf(']]', i + 2);
      if (close > i + 1) {
        const inner = input.slice(i + 2, close);
        // Reject if the inner contains a fence-like sequence that would
        // suggest the closer is in a different construct.
        if (!inner.includes('\n')) {
          flushText();
          const pipe = inner.indexOf('|');
          const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
          const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
          if (target.length > 0) {
            out.push({ kind: 'wikilink', target, label: label || target });
            i = close + 2;
            continue;
          }
        }
      }
    }
    // Spoiler: ||spoiler||
    if (ch === '|' && next === '|') {
      const close = input.indexOf('||', i + 2);
      if (close > i + 1) {
        flushText();
        out.push({ kind: 'spoiler', value: input.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    // Strikethrough: ~~strike~~
    if (ch === '~' && next === '~') {
      const close = input.indexOf('~~', i + 2);
      if (close > i + 1) {
        flushText();
        out.push({ kind: 'strike', value: input.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    // Bold: **bold**
    if (ch === '*' && next === '*') {
      const close = input.indexOf('**', i + 2);
      if (close > i + 1) {
        flushText();
        out.push({ kind: 'bold', value: input.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    // Italic: *italic* or _italic_
    if ((ch === '*' || ch === '_') && next && next !== ch) {
      const close = input.indexOf(ch, i + 1);
      if (close > i) {
        flushText();
        out.push({ kind: 'italic', value: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    textBuf += ch;
    i += 1;
  }
  flushText();
  return out;
}

/**
 * Walk a plain-text run and split out @mention and #channel-mention segments.
 * Anything not matched is preserved as a `text` segment. URLs are handled by
 * the inline tokenizer (see URL_AT_RE), not here.
 */
function splitOnMentions(input: string): Segment[] {
  type Hit = { start: number; end: number; build: () => Segment };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  MENTION_REGEX.lastIndex = 0;
  while ((m = MENTION_REGEX.exec(input)) !== null) {
    // MENTION_REGEX uses a non-capturing lead group: group 1 = localpart,
    // group 2 = host. Recover the lead length by checking whether m[0] starts
    // with a non-@ character (the leading whitespace/bracket consumed by the
    // `(?:^|[\s(\[{])` prefix).
    const leadLen = m[0].startsWith('@') ? 0 : 1;
    const start = m.index + leadLen;
    const end = m.index + m[0].length;
    const localpart = m[1] ?? '';
    const host = m[2] ?? '';
    // Emit a qualifiedMention when there's a host part containing a dot.
    if (host && host.includes('.')) {
      const raw = `@${localpart}@${host}`;
      hits.push({ start, end, build: () => ({ kind: 'qualifiedMention', raw, localpart, host }) });
    } else {
      const raw = `@${localpart}`;
      hits.push({ start, end, build: () => ({ kind: 'mention', raw }) });
    }
  }
  CHANNEL_RE.lastIndex = 0;
  while ((m = CHANNEL_RE.exec(input)) !== null) {
    const lead = m[1] ?? '';
    const start = m.index + lead.length;
    const end = m.index + m[0].length;
    const name = m[2] ?? '';
    if (!name) continue;
    const raw = `#${name}`;
    hits.push({ start, end, build: () => ({ kind: 'channel-mention', raw, name }) });
  }
  if (hits.length === 0) return [{ kind: 'text', value: input }];
  hits.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue; // overlapping hit; first wins.
    if (h.start > cursor) {
      out.push({ kind: 'text', value: input.slice(cursor, h.start) });
    }
    out.push(h.build());
    cursor = h.end;
  }
  if (cursor < input.length) {
    out.push({ kind: 'text', value: input.slice(cursor) });
  }
  return out;
}
