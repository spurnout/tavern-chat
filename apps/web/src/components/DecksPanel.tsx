import { useEffect, useState } from 'react';
import { Layers, Plus, Shuffle, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface Card {
  id: string;
  label: string;
  body?: string;
}

interface Deck {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  cards: Card[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface DrawResult {
  deckId: string;
  deckName: string;
  card: Card;
  drawnBy: string;
  drawnAt: string;
  isPrivate: boolean;
}

interface Props {
  serverId: string;
  /** Optional channel to post draw results into. */
  channelId?: string;
}

/**
 * Wave 3 #20 — per-server custom card decks.
 *
 * Lists, creates, edits, deletes, and draws from decks. Drawing posts a
 * system message to `channelId` when provided; otherwise the draw stays in
 * the panel and the user can choose to share it. Each card has a short
 * label and an optional longer body.
 */
export function DecksPanel({ serverId, channelId }: Props): JSX.Element {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftCardsRaw, setDraftCardsRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [recentDraw, setRecentDraw] = useState<DrawResult | null>(null);
  const [deckToDelete, setDeckToDelete] = useState<Deck | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<Deck[]>(`/servers/${serverId}/decks`);
      setDecks(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load decks');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  function parseCardsInput(input: string): Card[] {
    // One card per line. `Label | Body` if a pipe is present; otherwise the
    // entire line is the label and the body is empty.
    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.map((line, idx) => {
      const pipe = line.indexOf('|');
      const label = pipe >= 0 ? line.slice(0, pipe).trim() : line;
      const body = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
      return { id: `c${idx + 1}`, label, ...(body ? { body } : {}) };
    });
  }

  async function create(): Promise<void> {
    const cards = parseCardsInput(draftCardsRaw);
    if (cards.length === 0) {
      toast.error('Add at least one card.');
      return;
    }
    if (!draftName.trim()) {
      toast.error('Give the deck a name.');
      return;
    }
    setBusy(true);
    try {
      await api(`/servers/${serverId}/decks`, {
        method: 'POST',
        body: {
          name: draftName.trim(),
          description: draftDescription.trim() || undefined,
          cards,
        },
      });
      setDraftName('');
      setDraftDescription('');
      setDraftCardsRaw('');
      setCreating(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create deck');
    } finally {
      setBusy(false);
    }
  }

  async function draw(deck: Deck, opts: { post: boolean; isPrivate: boolean }): Promise<void> {
    try {
      const r = await api<DrawResult>(`/decks/${deck.id}/draw`, {
        method: 'POST',
        body: {
          ...(opts.post && channelId ? { channelId } : {}),
          isPrivate: opts.isPrivate,
        },
      });
      setRecentDraw(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not draw');
    }
  }

  async function remove(deck: Deck): Promise<void> {
    try {
      await api(`/decks/${deck.id}`, { method: 'DELETE' });
      setDecks((s) => s.filter((d) => d.id !== deck.id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setDeckToDelete(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex items-center gap-2">
        <Layers size={16} className="text-fg-muted" />
        <h3 className="font-serif">Decks</h3>
        <button
          type="button"
          className="btn-primary ml-auto text-sm"
          onClick={() => setCreating((v) => !v)}
        >
          <Plus size={14} className="mr-1 inline-block" /> {creating ? 'Cancel' : 'New deck'}
        </button>
      </header>
      {creating ? (
        <div className="card space-y-2 text-sm">
          <input
            className="input"
            placeholder="Deck name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            maxLength={80}
            disabled={busy}
          />
          <input
            className="input"
            placeholder="Short description (optional)"
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            maxLength={500}
            disabled={busy}
          />
          <textarea
            className="input min-h-[8rem] font-mono text-xs"
            placeholder={
              'One card per line. Use "Label | Body" to add detail.\n' +
              'Example:\n' +
              'The Sun | A turning point — describe a moment of clarity.\n' +
              'The Tower | Something unexpected falls.'
            }
            value={draftCardsRaw}
            onChange={(e) => setDraftCardsRaw(e.target.value)}
            disabled={busy}
          />
          <div className="text-right">
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={() => void create()}
              disabled={busy || !draftCardsRaw.trim() || !draftName.trim()}
            >
              Create deck
            </button>
          </div>
        </div>
      ) : null}
      {recentDraw ? (
        <div className="rounded border border-mead/60 bg-tint-ember/40 p-3 text-sm">
          <div className="mb-1 text-xs uppercase tracking-wider text-fg-muted">
            Drew from {recentDraw.deckName}
          </div>
          <div className="font-serif text-base">{recentDraw.card.label}</div>
          {recentDraw.card.body ? (
            <div className="mt-1 whitespace-pre-wrap text-fg-muted">{recentDraw.card.body}</div>
          ) : null}
          <button
            type="button"
            className="mt-2 text-xs text-fg-muted hover:underline"
            onClick={() => setRecentDraw(null)}
          >
            dismiss
          </button>
        </div>
      ) : null}
      {loading ? <p className="text-fg-muted">Loading…</p> : null}
      {!loading && decks.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No decks yet. Click <em>New deck</em> to make one — Deck of Many Things, fate decks,
          motivation prompts, anything you can write on a list.
        </p>
      ) : null}
      <ul className="space-y-2">
        {decks.map((d) => (
          <li key={d.id} className="card space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="font-serif font-medium">{d.name}</div>
                {d.description ? (
                  <div className="text-xs text-fg-muted">{d.description}</div>
                ) : null}
                <div className="text-xs text-fg-faint">
                  {d.cards.length} card{d.cards.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="btn-ghost text-sm"
                  onClick={() => void draw(d, { post: false, isPrivate: true })}
                  title="Draw a card only you see"
                >
                  <Shuffle size={14} className="mr-1 inline-block" /> Draw
                </button>
                {channelId ? (
                  <button
                    type="button"
                    className="btn-primary text-sm"
                    onClick={() => void draw(d, { post: true, isPrivate: false })}
                    title="Draw + post to chat"
                  >
                    <Shuffle size={14} className="mr-1 inline-block" /> Draw & share
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-ghost text-fg-muted hover:text-danger"
                  onClick={() => setDeckToDelete(d)}
                  aria-label="Delete deck"
                  title="Delete deck"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {deckToDelete ? (
        <ConfirmDialog
          title="Delete deck?"
          description={`Delete "${deckToDelete.name}"? This cannot be undone.`}
          confirmLabel="Delete deck"
          destructive
          onConfirm={() => void remove(deckToDelete)}
          onCancel={() => setDeckToDelete(null)}
        />
      ) : null}
    </div>
  );
}
