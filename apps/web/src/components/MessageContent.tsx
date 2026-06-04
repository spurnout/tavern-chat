import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import * as Popover from '@radix-ui/react-popover';
import { parseMarkdownBlocks, type Block, type Segment } from '../lib/markdown.js';
import { useRealtime } from '../lib/store.js';
import {
  highlight,
  isLanguageSupported,
  type HastElementNode,
  type HastNode,
} from '../lib/highlight.js';
import { api, ApiError } from '../lib/api-client.js';
import { RemoteUserCard, type RemoteUserCardData } from './RemoteUserCard.js';

interface Props {
  content: string;
}

/**
 * Renders a Tavern message body. Parses the markdown subset documented in
 * `lib/markdown.ts` into a typed segment tree and maps each segment to a
 * React node. No HTML strings, no dangerouslySetInnerHTML.
 */
export function MessageContent({ content }: Props): JSX.Element {
  const blocks = parseMarkdownBlocks(content);
  return (
    <div className="space-y-1 text-sm text-fg">
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} />
      ))}
    </div>
  );
}

function BlockNode({ block }: { block: Block }): JSX.Element | null {
  switch (block.kind) {
    case 'paragraph':
      if (block.segments.length === 1 && block.segments[0]?.kind === 'text' && block.segments[0].value.length === 0) {
        // Empty paragraph from a blank line — render a small spacer.
        return <div className="h-1" aria-hidden />;
      }
      return (
        <p className="whitespace-pre-wrap break-words">
          {block.segments.map((s, i) => (
            <InlineSegment key={i} segment={s} />
          ))}
        </p>
      );
    case 'codeblock': {
      // Wave 3 #11 — when a fenced block declares a language we recognise,
      // hand the body to `lowlight` and render the resulting hast tree as
      // <span> nodes. Anything we don't recognise (including no-language
      // fences) falls through to the original plain renderer.
      const highlighted =
        block.language && isLanguageSupported(block.language)
          ? highlight(block.language, block.value)
          : null;
      return (
        <pre className="overflow-x-auto rounded border border-subtle bg-canvas px-3 py-2 font-mono text-xs">
          {block.language ? (
            <span className="mb-1 block text-fg-muted">{block.language}</span>
          ) : null}
          {highlighted ? (
            <code className="hljs">{renderHast(highlighted)}</code>
          ) : (
            <code>{block.value}</code>
          )}
        </pre>
      );
    }
    case 'blockquote':
      return (
        <blockquote className="border-l-2 border-ember pl-3 text-fg-muted">
          {block.segments.map((s, i) => (
            <InlineSegment key={i} segment={s} />
          ))}
        </blockquote>
      );
    default:
      return null;
  }
}

function InlineSegment({ segment }: { segment: Segment }): JSX.Element {
  switch (segment.kind) {
    case 'text':
      return <>{segment.value}</>;
    case 'bold':
      return <strong>{segment.value}</strong>;
    case 'italic':
      return <em>{segment.value}</em>;
    case 'strike':
      return <s>{segment.value}</s>;
    case 'spoiler':
      return <Spoiler value={segment.value} />;
    case 'code':
      return (
        <code className="rounded bg-canvas px-1 py-0.5 font-mono text-xs">{segment.value}</code>
      );
    case 'link':
      return (
        <a
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-dusk underline decoration-dotted hover:decoration-solid"
        >
          {segment.label}
        </a>
      );
    case 'mention':
      return (
        <span className="rounded bg-tint-ember px-1 font-medium text-ember">{segment.raw}</span>
      );
    case 'channel-mention':
      return <ChannelMentionPill name={segment.name} raw={segment.raw} />;
    case 'qualifiedMention':
      return (
        <QualifiedMentionPill
          localpart={segment.localpart}
          host={segment.host}
          raw={segment.raw}
        />
      );
    case 'wikilink':
      // The note renderer in NotesTab assigns `id="note-<slug>"` for each
      // note title; clicking the wikilink scrolls that element into view.
      // The anchor is a no-op when no matching note exists on the page, but
      // the styling makes the cross-reference visible either way.
      return (
        <a
          href={`#note-${slugifyWikiTarget(segment.target)}`}
          className="rounded bg-tint-fg-04 px-1 font-medium text-dusk underline decoration-dotted hover:bg-raised"
          title={`Jump to "${segment.target}"`}
          onClick={(e) => {
            const slug = slugifyWikiTarget(segment.target);
            const target = document.getElementById(`note-${slug}`);
            if (target) {
              e.preventDefault();
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }}
        >
          {segment.label}
        </a>
      );
    default:
      return <></>;
  }
}

/**
 * Lower-case, strip punctuation, replace whitespace with dashes. Notes in
 * NotesTab assign the same slug to their `id` attribute so wikilinks
 * resolve via plain anchor navigation.
 */
function slugifyWikiTarget(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export { slugifyWikiTarget };

function QualifiedMentionPill({
  localpart,
  host,
}: {
  localpart: string;
  host: string;
  raw: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RemoteUserCardData | null>(null);

  async function load(): Promise<void> {
    if (data || loading) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await api<RemoteUserCardData>(
        `/federation/users/${encodeURIComponent(`${localpart}@${host}`)}/profile`,
      );
      setData(resp);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load profile');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="rounded bg-tint-ember px-1 font-medium text-ember hover:bg-tint-good"
        >
          @{localpart}
          <span className="ml-1 text-xs opacity-60">@{host}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} className="z-50">
          <RemoteUserCard loading={loading} error={error} data={data} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ChannelMentionPill({ name, raw }: { name: string; raw: string }): JSX.Element {
  // Resolve the channel by name across all visible servers. First match wins.
  const target = useRealtime((s) => {
    for (const [serverId, channels] of Object.entries(s.channelsByServer)) {
      const c = channels.find((ch) => ch.name === name && ch.type !== 'voice' && ch.type !== 'stage');
      if (c) return { serverId, channelId: c.id };
    }
    return null;
  });
  if (target) {
    return (
      <Link
        to="/app/servers/$serverId/channels/$channelId"
        params={{ serverId: target.serverId, channelId: target.channelId }}
        className="rounded bg-tint-fg-04 px-1 font-medium text-mead hover:bg-raised"
      >
        #{name}
      </Link>
    );
  }
  return <span className="rounded bg-tint-fg-04 px-1 text-fg-muted">{raw}</span>;
}

/**
 * Render a lowlight `hast` tree as React nodes. Element nodes become
 * `<span>`s carrying their hljs class names; text nodes become literal
 * strings. No HTML string is ever constructed.
 */
function renderHast(node: HastNode, key: number | string = 'root'): ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type === 'root') {
    return node.children.map((c, i) => renderHast(c, i));
  }
  // element
  const el = node as HastElementNode;
  const className = el.properties?.className;
  const flatClass = Array.isArray(className) ? className.join(' ') : className ?? undefined;
  return (
    <span key={key} className={flatClass}>
      {el.children.map((c, i) => renderHast(c, i))}
    </span>
  );
}

function Spoiler({ value }: { value: string }): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRevealed((v) => !v)}
      className={
        revealed
          ? 'cursor-pointer rounded px-1'
          : 'cursor-pointer rounded bg-fg px-1 text-fg hover:bg-fg-muted'
      }
      aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
      title={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
    >
      <span className={revealed ? '' : 'invisible'}>{value}</span>
    </button>
  );
}
