import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';

interface SessionRecap {
  id: string;
  campaignId: string;
  sessionId: string | null;
  body: string;
  modelUsed: string;
  generatedBy: string;
  createdAt: string;
}

interface Props {
  campaignId: string;
  sessionId: string;
}

/**
 * Wave 3 #48 — "Generate recap" affordance on a campaign session.
 *
 * Clicks call POST /api/campaigns/:id/recaps with the sessionId; the server
 * pulls recent channel messages as the transcript and POSTs to the
 * operator-configured LLM endpoint. Result renders inline with an "Edit"
 * mode (PATCH /api/recaps/:id) so the GM can refine before sharing.
 *
 * The whole feature degrades cleanly when no LLM endpoint is configured:
 * the API returns 503 with a clear message, and the toast surfaces it.
 */
export function SessionRecapButton({ campaignId, sessionId }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [recap, setRecap] = useState<SessionRecap | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');

  async function generate(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<SessionRecap>(`/campaigns/${campaignId}/recaps`, {
        method: 'POST',
        body: { sessionId },
      });
      setRecap(r);
      setEditDraft(r.body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        toast.error('AI recap isn’t configured on this instance.');
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Could not generate recap');
      }
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!recap) return;
    setBusy(true);
    try {
      const r = await api<SessionRecap>(`/recaps/${recap.id}`, {
        method: 'PATCH',
        body: { body: editDraft },
      });
      setRecap(r);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!recap) return;
    try {
      await api(`/recaps/${recap.id}`, { method: 'DELETE' });
    } catch {
      // Best-effort
    }
    setRecap(null);
    setEditDraft('');
    setEditing(false);
  }

  if (!recap) {
    return (
      <button
        type="button"
        className="btn-ghost text-xs"
        onClick={() => void generate()}
        disabled={busy}
        title="Generate an AI recap from session chat"
      >
        <Sparkles size={12} className="mr-1 inline-block" />
        {busy ? 'Generating…' : 'Generate recap'}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded border border-mead/40 bg-tint-ember/30 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
        <Sparkles size={12} />
        <span>Generated with {recap.modelUsed}</span>
        <button
          type="button"
          className="ml-auto hover:underline"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Cancel' : 'Edit'}
        </button>
        <button
          type="button"
          className="text-danger hover:underline"
          onClick={() => void discard()}
          aria-label="Discard recap"
          title="Discard recap"
        >
          <X size={12} />
        </button>
      </div>
      {editing ? (
        <>
          <textarea
            className="input min-h-[10rem] w-full"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            disabled={busy}
          />
          <div className="mt-2 text-right">
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => void save()}
              disabled={busy || !editDraft.trim()}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap">{recap.body}</p>
      )}
    </div>
  );
}
