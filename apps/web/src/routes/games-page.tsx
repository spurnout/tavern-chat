import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Calendar, Dice5 } from 'lucide-react';
import type { BoardGame, GameNight } from '@tavern/shared';
import { api } from '../lib/api-client.js';

export function GamesPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [games, setGames] = useState<BoardGame[]>([]);
  const [nights, setNights] = useState<GameNight[]>([]);
  const [filterPlayers, setFilterPlayers] = useState<number | ''>('');
  const [filterTime, setFilterTime] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!serverId) return;
    setLoading(true);
    let cancelled = false;
    Promise.all([
      api<BoardGame[]>(`/servers/${serverId}/board-games`, {
        query: {
          players: filterPlayers || undefined,
          maxPlayTimeMinutes: filterTime || undefined,
        },
      }),
      api<GameNight[]>(`/servers/${serverId}/game-nights`),
    ])
      .then(([g, n]) => {
        if (cancelled) return;
        setGames(g);
        setNights(n);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [serverId, filterPlayers, filterTime]);

  if (!serverId) return <div className="p-12">Pick a server.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-tavern-oak px-4 py-3">
        <Dice5 size={16} className="text-tavern-mist" />
        <span className="font-semibold">Game library &amp; nights</span>
      </header>

      <div className="space-y-8 p-6">
        <section>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <h2 className="text-lg font-semibold">Library</h2>
            <label className="text-xs">
              <span className="mb-0.5 block text-tavern-mist">Players</span>
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
              <span className="mb-0.5 block text-tavern-mist">Max minutes</span>
              <input
                type="number"
                min={5}
                step={5}
                className="input w-24"
                value={filterTime}
                onChange={(e) => setFilterTime(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </label>
          </div>
          {loading ? <p className="text-tavern-mist">Loading…</p> : null}
          {!loading && games.length === 0 ? (
            <p className="text-tavern-mist">
              No games match. Add one via{' '}
              <code className="font-mono text-xs">
                POST /api/servers/{serverId}/board-games
              </code>
              .
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <article key={g.id} className="card space-y-2">
                <h3 className="text-base font-semibold">{g.name}</h3>
                <div className="flex flex-wrap gap-2 text-xs text-tavern-mist">
                  <span>
                    {g.minPlayers === g.maxPlayers
                      ? `${g.minPlayers} players`
                      : `${g.minPlayers}–${g.maxPlayers} players`}
                  </span>
                  {g.playTimeMinutes ? <span>{g.playTimeMinutes} min</span> : null}
                  {g.complexity ? <span>complexity {g.complexity.toFixed(1)}/5</span> : null}
                </div>
                {g.description ? (
                  <p className="text-sm text-tavern-parchment">{g.description}</p>
                ) : null}
                {g.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {g.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded border border-tavern-oak px-1.5 py-0.5 text-xs text-tavern-mist"
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
            <Calendar size={16} className="text-tavern-mist" />
            <h2 className="text-lg font-semibold">Game nights</h2>
          </div>
          {nights.length === 0 ? (
            <p className="text-tavern-mist">No game nights scheduled yet.</p>
          ) : (
            <ul className="space-y-2">
              {nights.map((n) => (
                <li key={n.id} className="card flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{n.title}</div>
                    <div className="text-xs text-tavern-mist">
                      {n.scheduledStart
                        ? new Date(n.scheduledStart).toLocaleString()
                        : 'unscheduled'}
                      {n.location ? ` · ${n.location}` : ''}
                    </div>
                  </div>
                  <span className="text-xs uppercase tracking-wider text-tavern-mead">
                    {n.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
