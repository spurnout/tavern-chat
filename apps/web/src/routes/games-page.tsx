import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Calendar, Dice5, Plus } from 'lucide-react';
import type {
  BoardGame,
  CreateBoardGameRequest,
  CreateGameNightRequest,
  GameNight,
  GameNightCandidate,
} from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { Modal } from '../components/Modal.js';

export function GamesPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [games, setGames] = useState<BoardGame[]>([]);
  const [nights, setNights] = useState<GameNight[]>([]);
  const [filterPlayers, setFilterPlayers] = useState<number | ''>('');
  const [filterTime, setFilterTime] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [createGameOpen, setCreateGameOpen] = useState(false);
  const [createNightOpen, setCreateNightOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (!serverId) return;
    setLoading(true);
    try {
      const [g, n] = await Promise.all([
        api<BoardGame[]>(`/servers/${serverId}/board-games`, {
          query: {
            players: filterPlayers || undefined,
            maxPlayTimeMinutes: filterTime || undefined,
          },
        }),
        api<GameNight[]>(`/servers/${serverId}/game-nights`),
      ]);
      setGames(g);
      setNights(n);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, filterPlayers, filterTime]);

  if (!serverId) return <div className="p-12">Pick a den.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Dice5 size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Game library &amp; nights</span>
      </header>

      <div className="space-y-8 p-6">
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <section>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <h2 className="font-serif text-lg font-medium">Library</h2>
            <label className="text-xs">
              <span className="mb-0.5 block text-fg-muted">Players</span>
              <input
                type="number"
                min={1}
                max={20}
                className="input w-24"
                value={filterPlayers}
                onChange={(e) =>
                  setFilterPlayers(e.target.value === '' ? '' : Number(e.target.value))
                }
              />
            </label>
            <label className="text-xs">
              <span className="mb-0.5 block text-fg-muted">Max minutes</span>
              <input
                type="number"
                min={5}
                step={5}
                className="input w-24"
                value={filterTime}
                onChange={(e) => setFilterTime(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </label>
            <button
              className="ml-auto btn-primary text-sm"
              onClick={() => setCreateGameOpen(true)}
            >
              <Plus size={14} className="mr-1" /> Add game
            </button>
          </div>
          {loading ? <p className="text-fg-muted">Loading…</p> : null}
          {!loading && games.length === 0 ? (
            <p className="text-fg-muted">No games match.</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <article key={g.id} className="card space-y-2">
                <h3 className="font-serif text-base font-medium">{g.name}</h3>
                <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
                  <span>
                    {g.minPlayers === g.maxPlayers
                      ? `${g.minPlayers} players`
                      : `${g.minPlayers}–${g.maxPlayers} players`}
                  </span>
                  {g.playTimeMinutes ? <span>{g.playTimeMinutes} min</span> : null}
                  {g.complexity ? <span>complexity {g.complexity.toFixed(1)}/5</span> : null}
                </div>
                {g.description ? (
                  <p className="text-sm text-fg">{g.description}</p>
                ) : null}
                {g.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {g.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded border border-subtle px-1.5 py-0.5 text-xs text-fg-muted"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <Calendar size={16} className="text-fg-muted" />
            <h2 className="font-serif text-lg font-medium">Game nights</h2>
            <button
              className="ml-auto btn-primary text-sm"
              onClick={() => setCreateNightOpen(true)}
            >
              <Plus size={14} className="mr-1" /> Plan a night
            </button>
          </div>
          {nights.length === 0 ? (
            <p className="text-fg-muted">No game nights scheduled yet.</p>
          ) : (
            <ul className="space-y-3">
              {nights.map((n) => (
                <GameNightCard
                  key={n.id}
                  gameNight={n}
                  games={games}
                  onChange={() => void refresh()}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <CreateBoardGameModal
        serverId={serverId}
        open={createGameOpen}
        onOpenChange={setCreateGameOpen}
        onCreated={() => void refresh()}
      />
      <CreateGameNightModal
        serverId={serverId}
        games={games}
        open={createNightOpen}
        onOpenChange={setCreateNightOpen}
        onCreated={() => void refresh()}
      />
    </div>
  );
}

// ---- Game-night card ------------------------------------------------------

function GameNightCard({
  gameNight,
  games,
  onChange,
}: {
  gameNight: GameNight;
  games: BoardGame[];
  onChange: () => void;
}): JSX.Element {
  const [candidates, setCandidates] = useState<GameNightCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const c = await api<GameNightCandidate[]>(`/game-nights/${gameNight.id}/candidates`);
      setCandidates(c);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameNight.id]);

  async function rsvp(status: 'yes' | 'no' | 'maybe' | 'late'): Promise<void> {
    try {
      await api(`/game-nights/${gameNight.id}/rsvp`, { method: 'PUT', body: { status } });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'RSVP failed');
    }
  }

  async function vote(boardGameId: string): Promise<void> {
    try {
      await api(`/game-nights/${gameNight.id}/votes`, {
        method: 'POST',
        body: { boardGameId },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vote failed');
    }
  }

  async function propose(boardGameId: string): Promise<void> {
    try {
      await api(`/game-nights/${gameNight.id}/candidates`, {
        method: 'POST',
        body: { boardGameId },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Propose failed');
    }
  }

  const candidateIds = new Set(candidates.map((c) => c.boardGameId));
  const proposable = games.filter((g) => !candidateIds.has(g.id));

  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-serif font-medium">{gameNight.title}</div>
          <div className="text-xs text-fg-muted">
            <span className="font-mono">
              {gameNight.scheduledStart
                ? new Date(gameNight.scheduledStart).toLocaleString()
                : 'unscheduled'}
            </span>
            {gameNight.location ? ` · ${gameNight.location}` : ''}
          </div>
        </div>
        <span className="text-xs uppercase tracking-wider text-mead">
          {gameNight.status}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        <span className="text-fg-muted">RSVP:</span>
        {(['yes', 'maybe', 'no', 'late'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => void rsvp(v)}
            className="rounded border border-subtle px-2 py-0.5 hover:bg-raised"
          >
            {v}
          </button>
        ))}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-fg-muted">Candidates</div>
        {candidates.length === 0 ? (
          <p className="text-xs text-fg-muted">No candidates yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {candidates.map((c) => {
              const game = games.find((g) => g.id === c.boardGameId);
              return (
                <li key={c.boardGameId} className="flex items-center justify-between text-sm">
                  <span>{game?.name ?? c.boardGameId.slice(0, 8)}</span>
                  <button
                    type="button"
                    onClick={() => void vote(c.boardGameId)}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      c.meVoted
                        ? 'border-ember bg-tint-ember text-mead'
                        : 'border-subtle hover:bg-raised'
                    }`}
                  >
                    {c.voteCount} vote{c.voteCount === 1 ? '' : 's'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {proposable.length > 0 ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-fg-muted">propose another</summary>
            <ul className="mt-1 grid grid-cols-2 gap-1">
              {proposable.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => void propose(g.id)}
                    className="w-full rounded border border-subtle px-2 py-0.5 text-left hover:bg-raised"
                  >
                    {g.name}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

// ---- Create board game ----------------------------------------------------

function CreateBoardGameModal({
  serverId,
  open,
  onOpenChange,
  onCreated,
}: {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [minPlayers, setMinPlayers] = useState(2);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [playTime, setPlayTime] = useState<number | ''>('');
  const [complexity, setComplexity] = useState<number | ''>('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: CreateBoardGameRequest = {
        name: name.trim(),
        description: description.trim() || undefined,
        minPlayers,
        maxPlayers,
        ...(typeof playTime === 'number' ? { playTimeMinutes: playTime } : {}),
        ...(typeof complexity === 'number' ? { complexity } : {}),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      };
      await api(`/servers/${serverId}/board-games`, { method: 'POST', body });
      onCreated();
      onOpenChange(false);
      setName('');
      setDescription('');
      setTags('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a game"
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Saving…' : 'Add'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Description</span>
        <textarea
          className="input min-h-[4rem]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <label>
          <span className="mb-1 inline-block text-fg-muted">Min players</span>
          <input
            type="number"
            min={1}
            max={20}
            className="input"
            value={minPlayers}
            onChange={(e) => setMinPlayers(Number(e.target.value))}
          />
        </label>
        <label>
          <span className="mb-1 inline-block text-fg-muted">Max players</span>
          <input
            type="number"
            min={1}
            max={20}
            className="input"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(Number(e.target.value))}
          />
        </label>
        <label>
          <span className="mb-1 inline-block text-fg-muted">Minutes</span>
          <input
            type="number"
            min={5}
            step={5}
            className="input"
            value={playTime}
            onChange={(e) => setPlayTime(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
        <label>
          <span className="mb-1 inline-block text-fg-muted">Complexity (1–5)</span>
          <input
            type="number"
            min={1}
            max={5}
            step={0.1}
            className="input"
            value={complexity}
            onChange={(e) => setComplexity(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Tags (comma-separated)</span>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}

// ---- Create game night ----------------------------------------------------

function CreateGameNightModal({
  serverId,
  games,
  open,
  onOpenChange,
  onCreated,
}: {
  serverId: string;
  games: BoardGame[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [location, setLocation] = useState('');
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCandidate(id: string): void {
    setCandidateIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: CreateGameNightRequest = {
        title: title.trim(),
        ...(start ? { scheduledStart: new Date(start).toISOString() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(candidateIds.length > 0 ? { candidateBoardGameIds: candidateIds } : {}),
      };
      await api(`/servers/${serverId}/game-nights`, { method: 'POST', body });
      onCreated();
      onOpenChange(false);
      setTitle('');
      setStart('');
      setLocation('');
      setCandidateIds([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Plan a game night"
      footer={
        <>
          <button className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
          >
            {busy ? 'Saving…' : 'Plan'}
          </button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">When</span>
        <input
          type="datetime-local"
          className="input"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 inline-block text-fg-muted">Location (optional)</span>
        <input
          className="input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </label>
      {games.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-xs uppercase tracking-wider text-fg-muted">
            Candidate games
          </div>
          <ul className="grid grid-cols-2 gap-1 text-sm">
            {games.map((g) => (
              <li key={g.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 hover:bg-raised">
                  <input
                    type="checkbox"
                    checked={candidateIds.includes(g.id)}
                    onChange={() => toggleCandidate(g.id)}
                  />
                  <span className="truncate">{g.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
