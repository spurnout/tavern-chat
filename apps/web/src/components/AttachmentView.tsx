import { useEffect, useState } from 'react';
import { File as FileIcon, ShieldAlert } from 'lucide-react';
import type { Attachment } from '@tavern/shared';
import { api } from '../lib/api-client.js';

// LRU-bounded module cache. A long chat session can scroll past thousands of
// distinct attachments; the cap keeps memory in check while still avoiding
// refetches for anything the user looked at recently. Map preserves insertion
// order, so the oldest untouched entry is always the first key.
const CACHE_LIMIT = 500;
const cache = new Map<string, Attachment>();

// Pure read — safe to call from render (e.g. useState initializer).
function cachePeek(id: string): Attachment | undefined {
  return cache.get(id);
}

// Side-effect: bump recency by re-inserting at the tail. Call from an effect.
function cacheTouch(id: string): void {
  const v = cache.get(id);
  if (v !== undefined) {
    cache.delete(id);
    cache.set(id, v);
  }
}

function cacheSet(id: string, att: Attachment): void {
  if (cache.has(id)) {
    cache.delete(id);
  } else if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, att);
}

// Callers must pass `key={id}` when rendering this component so a changed
// `id` forces a remount. Without that, `att` would be a stale closure over
// the previous attachment.
export function AttachmentView({ id }: { id: string }): JSX.Element {
  const [att, setAtt] = useState<Attachment | null>(cachePeek(id) ?? null);

  useEffect(() => {
    if (att) {
      cacheTouch(id);
      return;
    }
    let cancelled = false;
    api<Attachment>(`/attachments/${id}`)
      .then((a) => {
        if (cancelled) return;
        cacheSet(id, a);
        setAtt(a);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, att]);

  if (!att) {
    return (
      <div className="my-1 inline-block rounded border border-subtle bg-surface px-2 py-1 text-xs text-fg-muted">
        attachment loading…
      </div>
    );
  }

  if (att.status === 'quarantined' || att.status === 'blocked') {
    return (
      <div className="my-1 flex items-center gap-2 rounded border border-danger bg-tint-danger px-3 py-2 text-xs text-danger">
        <ShieldAlert size={14} />
        <span>This attachment was held by moderation.</span>
      </div>
    );
  }

  if (att.status !== 'ready') {
    return (
      <div className="my-1 inline-block rounded border border-subtle bg-surface px-2 py-1 text-xs text-fg-muted">
        Scanning {att.filename}…
      </div>
    );
  }

  if (att.kind === 'image' || att.kind === 'gif' || att.kind === 'map') {
    return (
      <a href={att.url ?? '#'} target="_blank" rel="noreferrer" className="my-1 inline-block">
        <img
          src={att.thumbnailUrl ?? att.url ?? ''}
          alt={att.filename}
          loading="lazy"
          className="max-h-72 max-w-md rounded border border-subtle object-contain"
        />
      </a>
    );
  }

  if (att.kind === 'video') {
    return (
      <video
        controls
        preload="metadata"
        src={att.url ?? ''}
        className="my-1 max-h-72 max-w-md rounded border border-subtle"
      />
    );
  }

  if (att.kind === 'audio' || att.kind === 'voice_message') {
    return (
      <div className="my-1 flex items-center gap-3 rounded border border-subtle bg-surface px-3 py-2">
        {att.waveform && att.waveform.length > 0 ? (
          <Waveform values={att.waveform} />
        ) : (
          <div className="h-6 w-32 rounded bg-raised" />
        )}
        <audio controls src={att.url ?? ''} className="h-9" />
      </div>
    );
  }

  return (
    <a
      href={att.url ?? '#'}
      target="_blank"
      rel="noreferrer"
      className="my-1 inline-flex max-w-md items-center gap-2 rounded border border-subtle bg-surface px-3 py-2 text-sm hover:bg-raised"
    >
      <FileIcon size={16} className="text-fg-muted" />
      <span className="truncate">{att.filename}</span>
      <span className="ml-auto text-xs text-fg-muted">
        {Math.round(att.sizeBytes / 1024)} KB
      </span>
    </a>
  );
}

function Waveform({ values }: { values: number[] }): JSX.Element {
  const max = Math.max(1, ...values);
  return (
    <svg width={values.length * 3} height={28} className="text-ember">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * 24);
        return (
          <rect
            key={i}
            x={i * 3}
            y={(28 - h) / 2}
            width={2}
            height={h}
            rx={1}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}
