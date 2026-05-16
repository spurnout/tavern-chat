import { useEffect, useState } from 'react';
import { Eye, EyeOff, Plus, Shield, Trash2 } from 'lucide-react';
import type { Campaign } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';

type SafetyKind = 'line' | 'veil' | 'star' | 'wish' | 'note';

interface SafetyEntry {
  id: string;
  campaignId: string;
  authorId: string;
  kind: SafetyKind;
  content: string;
  isPrivate: boolean;
  createdAt: string;
}

const KIND_LABEL: Record<SafetyKind, string> = {
  line: 'Line — never include',
  veil: 'Veil — fade to black',
  star: 'Star — loved this',
  wish: 'Wish — want more of',
  note: 'Note',
};

const KIND_DEFAULT_PRIVATE: Record<SafetyKind, boolean> = {
  line: true,
  veil: true,
  star: false,
  wish: false,
  note: false,
};

const KIND_ORDER: SafetyKind[] = ['line', 'veil', 'star', 'wish', 'note'];

/**
 * Wave 3 #23 — collaborative safety panel.
 *
 * Lines and veils default to private (only GM + author see them); stars and
 * wishes default to public so the whole table can read them. The author can
 * override either default; the API enforces the visibility on read.
 */
export function SafetyTab({ campaign }: { campaign: Campaign }): JSX.Element {
  const [entries, setEntries] = useState<SafetyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftKind, setDraftKind] = useState<SafetyKind>('star');
  const [draftContent, setDraftContent] = useState('');
  const [draftPrivate, setDraftPrivate] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<SafetyEntry[]>(`/campaigns/${campaign.id}/safety`);
      setEntries(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load entries');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id]);

  async function add(): Promise<void> {
    if (draftContent.trim().length === 0) return;
    setBusy(true);
    try {
      const isPrivate = draftPrivate ?? KIND_DEFAULT_PRIVATE[draftKind];
      await api(`/campaigns/${campaign.id}/safety`, {
        method: 'POST',
        body: { kind: draftKind, content: draftContent.trim(), isPrivate },
      });
      setDraftContent('');
      setDraftPrivate(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/safety-entries/${id}`, { method: 'DELETE' });
      setEntries((s) => s.filter((e) => e.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove');
    }
  }

  const grouped: Record<SafetyKind, SafetyEntry[]> = {
    line: [],
    veil: [],
    star: [],
    wish: [],
    note: [],
  };
  for (const e of entries) {
    if (KIND_ORDER.includes(e.kind)) {
      grouped[e.kind].push(e);
    }
  }

  const effectivePrivate = draftPrivate ?? KIND_DEFAULT_PRIVATE[draftKind];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="rounded border border-subtle bg-surface p-4">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-fg-muted" />
          <h3 className="font-serif text-base">Safety tools</h3>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Lines and veils mark off-limits content. Stars and wishes are end-of-session feedback
          shared with the table. Lines and veils default to private (GM-only); stars and wishes
          default to public.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[160px_1fr_auto]">
          <select
            className="input"
            value={draftKind}
            onChange={(e) => {
              setDraftKind(e.target.value as SafetyKind);
              setDraftPrivate(null);
            }}
            disabled={busy}
          >
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder="What should the table know?"
            maxLength={2000}
            disabled={busy}
          />
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={() => void add()}
            disabled={busy || !draftContent.trim()}
          >
            <Plus size={14} className="mr-1 inline-block" /> Add
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
          <button
            type="button"
            onClick={() => setDraftPrivate(!effectivePrivate)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-raised"
            title={effectivePrivate ? 'Make visible to the whole table' : 'Keep private (GM-only)'}
          >
            {effectivePrivate ? <EyeOff size={12} /> : <Eye size={12} />}
            {effectivePrivate ? 'Private (GM only)' : 'Visible to the table'}
          </button>
        </div>
      </header>
      {loading ? (
        <p className="text-fg-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No safety entries yet. Add a line, veil, star, or wish above to get the table on the same
          page.
        </p>
      ) : (
        <div className="space-y-4">
          {KIND_ORDER.filter((k) => grouped[k].length > 0).map((k) => (
            <section key={k}>
              <h4 className="mb-2 text-xs uppercase tracking-wider text-fg-muted">
                {KIND_LABEL[k]}
              </h4>
              <ul className="space-y-1">
                {grouped[k].map((e) => (
                  <li
                    key={e.id}
                    className="group flex items-start gap-2 rounded border border-subtle bg-surface p-2 text-sm"
                  >
                    <span className="flex-1 whitespace-pre-wrap break-words">{e.content}</span>
                    {e.isPrivate ? (
                      <span
                        className="text-fg-muted"
                        title="Private — only the GM and the author see this"
                      >
                        <EyeOff size={12} />
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void remove(e.id)}
                      className="hidden rounded p-1 text-fg-muted hover:bg-raised group-hover:block"
                      aria-label="Remove"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
