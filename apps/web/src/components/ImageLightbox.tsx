import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useLightbox } from '../lib/lightbox-store.js';

/**
 * Full-viewport modal that displays the currently-active attachment from
 * `useLightbox`. Mounted once at the AppShell level so any image trigger
 * across the app can open it.
 *
 * Keyboard: ← / → / Esc.
 */
export function ImageLightbox(): JSX.Element | null {
  const open = useLightbox((s) => s.open);
  const images = useLightbox((s) => s.images);
  const index = useLightbox((s) => s.index);
  const close = useLightbox((s) => s.close);
  const next = useLightbox((s) => s.next);
  const prev = useLightbox((s) => s.prev);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, next, prev]);

  if (!open || images.length === 0) return null;
  const active = images[index];
  if (!active) return null;

  return (
    <div
      role="dialog"
      aria-label="Image preview"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-canvas/95"
      onClick={close}
    >
      <header className="absolute inset-x-0 top-0 flex items-center gap-3 bg-canvas/70 px-4 py-2 text-sm text-fg">
        <span className="truncate font-mono">{active.filename}</span>
        <span className="ml-auto font-mono text-xs text-fg-muted">
          {index + 1} / {images.length}
        </span>
        <a
          href={active.url}
          download={active.filename}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="rounded p-1 hover:bg-raised"
          title="Download"
        >
          <Download size={16} />
        </a>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
          className="rounded p-1 hover:bg-raised"
          aria-label="Close"
          title="Close"
        >
          <X size={16} />
        </button>
      </header>

      {images.length > 1 ? (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            className="absolute left-4 rounded-full bg-surface/80 p-2 hover:bg-raised"
            aria-label="Previous image"
          >
            <ChevronLeft size={24} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            className="absolute right-4 rounded-full bg-surface/80 p-2 hover:bg-raised"
            aria-label="Next image"
          >
            <ChevronRight size={24} />
          </button>
        </>
      ) : null}

      <img
        src={active.url}
        alt={active.filename}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-[90vw] object-contain"
      />
    </div>
  );
}
