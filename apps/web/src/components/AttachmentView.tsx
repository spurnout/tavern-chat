import { useEffect, useState } from 'react';
import { File as FileIcon, ShieldAlert } from 'lucide-react';
import type { Attachment } from '@tavern/shared';
import { api } from '../lib/api-client.js';

const cache = new Map<string, Attachment>();

export function AttachmentView({ id }: { id: string }): JSX.Element {
  const [att, setAtt] = useState<Attachment | null>(cache.get(id) ?? null);

  useEffect(() => {
    if (att) return;
    let cancelled = false;
    api<Attachment>(`/attachments/${id}`)
      .then((a) => {
        if (cancelled) return;
        cache.set(id, a);
        setAtt(a);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, att]);

  if (!att) {
    return (
      <div className="my-1 inline-block rounded border border-tavern-oak bg-tavern-stone px-2 py-1 text-xs text-tavern-mist">
        attachment loading…
      </div>
    );
  }

  if (att.status === 'quarantined' || att.status === 'blocked') {
    return (
      <div className="my-1 flex items-center gap-2 rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
        <ShieldAlert size={14} />
        <span>This attachment was held by moderation.</span>
      </div>
    );
  }

  if (att.status !== 'ready') {
    return (
      <div className="my-1 inline-block rounded border border-tavern-oak bg-tavern-stone px-2 py-1 text-xs text-tavern-mist">
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
          className="max-h-72 max-w-md rounded border border-tavern-oak object-contain"
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
        className="my-1 max-h-72 max-w-md rounded border border-tavern-oak"
      />
    );
  }

  if (att.kind === 'audio' || att.kind === 'voice_message') {
    return (
      <div className="my-1 flex items-center gap-3 rounded border border-tavern-oak bg-tavern-stone px-3 py-2">
        {att.waveform && att.waveform.length > 0 ? (
          <Waveform values={att.waveform} />
        ) : (
          <div className="h-6 w-32 rounded bg-tavern-oak" />
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
      className="my-1 inline-flex max-w-md items-center gap-2 rounded border border-tavern-oak bg-tavern-stone px-3 py-2 text-sm hover:bg-tavern-oak"
    >
      <FileIcon size={16} className="text-tavern-mist" />
      <span className="truncate">{att.filename}</span>
      <span className="ml-auto text-xs text-tavern-mist">
        {Math.round(att.sizeBytes / 1024)} KB
      </span>
    </a>
  );
}

function Waveform({ values }: { values: number[] }): JSX.Element {
  const max = Math.max(1, ...values);
  return (
    <svg width={values.length * 3} height={28} className="text-tavern-ember">
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
