import { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface Edit {
  id: string;
  messageId: string;
  content: string;
  editedAt: string;
  editor: { id: string; displayName: string };
}

interface Props {
  messageId: string;
  currentContent: string;
  onClose: () => void;
}

export function MessageEditHistoryModal({ messageId, currentContent, onClose }: Props): JSX.Element {
  const [edits, setEdits] = useState<Edit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<Edit[]>(`/messages/${messageId}/edits`)
      .then((r) => {
        if (!cancelled) setEdits(r);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof ApiError ? err.message : 'Could not load history');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-canvas/70" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded border border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-serif text-lg">
            <History size={16} /> Edit history
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-raised" aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="mt-3 space-y-3 text-sm">
          {loading ? (
            <p className="text-fg-muted">Loading…</p>
          ) : (
            <>
              <Revision label="Current" content={currentContent} />
              {edits.length === 0 ? (
                <p className="text-fg-muted">This message has no recorded edits.</p>
              ) : (
                [...edits]
                  .reverse()
                  .map((e) => (
                    <Revision
                      key={e.id}
                      label={`${new Date(e.editedAt).toLocaleString()} · ${e.editor.displayName}`}
                      content={e.content}
                    />
                  ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Revision({ label, content }: { label: string; content: string }): JSX.Element {
  return (
    <div className="rounded border border-subtle bg-canvas p-2">
      <div className="text-xs font-mono text-fg-muted">{label}</div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm">{content || <em>(empty)</em>}</div>
    </div>
  );
}
