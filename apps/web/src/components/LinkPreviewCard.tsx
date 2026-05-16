import { useEffect, useState } from 'react';
import { useRealtime } from '../lib/store.js';
import { api } from '../lib/api-client.js';

export interface LinkPreviewDto {
  id: string;
  messageId: string;
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: string;
}

interface Props {
  messageId: string;
}

/**
 * Lazy-loaded OG / oEmbed unfurl card. Reads from the realtime store
 * (`linkPreviewsByMessage`) which the gateway populates on
 * LINK_PREVIEW_READY; falls back to the cold-load API after a short delay
 * for messages older than the gateway buffer.
 */
export function LinkPreviewCard({ messageId }: Props): JSX.Element | null {
  const previews = useRealtime((s) => s.linkPreviewsByMessage[messageId]) ?? null;
  const setPreviews = useRealtime((s) => s.setLinkPreviews);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (previews || tried) return;
    const t = setTimeout(() => {
      setTried(true);
      api<LinkPreviewDto[]>(`/messages/${messageId}/link-previews`)
        .then((rows) => {
          if (rows.length > 0) setPreviews(messageId, rows);
        })
        .catch(() => undefined);
    }, 1800);
    return () => clearTimeout(t);
  }, [messageId, previews, tried, setPreviews]);

  if (!previews || previews.length === 0) return null;
  return (
    <div className="my-1 space-y-2">
      {previews.map((p) => (
        <a
          key={p.id}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex max-w-md gap-3 rounded border border-subtle bg-surface p-2 text-sm hover:bg-raised"
        >
          {p.imageUrl ? (
            <img
              src={p.imageUrl}
              alt=""
              loading="lazy"
              className="h-16 w-16 shrink-0 rounded object-cover"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            {p.siteName ? (
              <span className="block text-[10px] font-mono uppercase tracking-wide text-fg-muted">
                {p.siteName}
              </span>
            ) : null}
            <span className="block truncate font-medium text-fg">{p.title ?? p.url}</span>
            {p.description ? (
              <span className="line-clamp-2 text-xs text-fg-muted">{p.description}</span>
            ) : null}
          </div>
        </a>
      ))}
    </div>
  );
}
