import { useEffect, useState } from 'react';
import type { BoardGame, GameNight, GameNightCandidate } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';

export function GameNightCard({
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
