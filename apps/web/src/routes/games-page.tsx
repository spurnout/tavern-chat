import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Calendar, Dice5, Plus } from 'lucide-react';
import type { BoardGame, GameNight } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { GameNightCard } from '../components/games/GameNightCard.js';
import { CreateBoardGameModal } from '../components/games/CreateBoardGameModal.js';
import { CreateGameNightModal } from '../components/games/CreateGameNightModal.js';

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

  if (!serverId) return <div className="p-12">Pick a tavern.</div>;

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
