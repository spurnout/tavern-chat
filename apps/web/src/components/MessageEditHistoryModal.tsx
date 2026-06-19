import { useEffect, useState } from 'react';
import { Modal } from './Modal.js';
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
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Edit history"
    >
      <div className="space-y-3 text-sm">
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
    </Modal>
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
