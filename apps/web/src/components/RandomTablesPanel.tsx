import { useEffect, useState } from 'react';
import { Dice5, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useRealtime } from '../lib/store.js';

interface TableRow {
  id: string;
  tableId: string;
  rangeMin: number;
  rangeMax: number;
  label: string;
  weight: number;
  resultText: string;
}

interface Table {
  id: string;
  serverId: string;
  campaignId: string | null;
  name: string;
  diceNotation: string;
  ownerId: string;
  createdAt: string;
  rows: TableRow[];
}

interface Props {
  serverId: string;
  campaignId?: string;
}

export function RandomTablesPanel({ serverId, campaignId }: Props): JSX.Element {
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [notation, setNotation] = useState('1d6');
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeChannelId = useRealtime((s) => s.activeChannelId);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<Table[]>(`/servers/${serverId}/tables`);
      const filtered = campaignId ? r.filter((t) => !t.campaignId || t.campaignId === campaignId) : r;
      setTables(filtered);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load tables');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [serverId, campaignId]);

  async function create(): Promise<void> {
    if (!name.trim()) return;
    try {
      await api(`/servers/${serverId}/tables`, {
        method: 'POST',
        body: {
          name: name.trim(),
          diceNotation: notation.trim(),
          campaignId: campaignId ?? null,
          rows: [
            { rangeMin: 1, rangeMax: 1, label: 'Result 1', weight: 1, resultText: 'A thing happens.' },
          ],
        },
      });
      setName('');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create');
    }
  }

  async function roll(t: Table): Promise<void> {
    try {
      const r = await api<{ matchedRow: { label: string; resultText: string } | null; roll: { total: number } }>(
        `/tables/${t.id}/roll`,
        { method: 'POST', body: { channelId: activeChannelId ?? undefined } },
      );
      if (r.matchedRow) {
        toast.info(`${t.name} → ${r.roll.total}: ${r.matchedRow.label}`);
      } else {
        toast.info(`${t.name} → ${r.roll.total} (no match)`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Roll failed');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/tables/${id}`, { method: 'DELETE' });
      setTables((s) => s.filter((t) => t.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  const active = tables.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-subtle bg-sunken">
        <div className="space-y-2 p-3">
          <h2 className="font-serif text-sm">Tables</h2>
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="New table name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input flex-1 text-sm"
              maxLength={120}
            />
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={notation}
              onChange={(e) => setNotation(e.target.value)}
              className="input flex-1 font-mono text-xs"
              placeholder="1d6"
              maxLength={40}
            />
            <button
              type="button"
              onClick={() => void create()}
              className="btn-primary text-xs"
              disabled={!name.trim()}
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <ul className="text-sm">
          {loading ? (
            <li className="px-3 py-2 text-fg-muted">Loading…</li>
          ) : tables.length === 0 ? (
            <li className="px-3 py-2 text-fg-muted">No tables.</li>
          ) : (
            tables.map((t) => (
              <li
                key={t.id}
                className={`flex items-center gap-2 border-b border-subtle px-3 py-2 ${
                  activeId === t.id ? 'bg-raised' : 'hover:bg-raised/50'
                }`}
              >
                <button type="button" onClick={() => setActiveId(t.id)} className="flex-1 text-left">
                  <div className="font-medium">{t.name}</div>
                  <div className="font-mono text-xs text-fg-muted">{t.diceNotation}</div>
                </button>
                <button
                  type="button"
                  onClick={() => void roll(t)}
                  className="rounded p-1 hover:bg-raised"
                  aria-label="Roll"
                  title="Roll"
                >
                  <Dice5 size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(t.id)}
                  className="rounded p-1 text-fg-muted hover:bg-raised"
                  aria-label="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      <main className="flex-1 overflow-y-auto p-4">
        {active ? (
          <TableEditor table={active} onUpdated={refresh} />
        ) : (
          <p className="text-fg-muted">Select a table or create one.</p>
        )}
      </main>
    </div>
  );
}

function TableEditor({ table, onUpdated }: { table: Table; onUpdated: () => Promise<void> }): JSX.Element {
  return (
    <div className="space-y-3">
      <header>
        <h2 className="font-serif text-xl">{table.name}</h2>
        <p className="text-xs text-fg-muted">
          Roll {table.diceNotation}. Rows in this table:
        </p>
      </header>
      <div className="rounded border border-subtle bg-canvas">
        <table className="w-full text-sm">
          <thead className="border-b border-subtle text-xs text-fg-muted">
            <tr>
              <th className="px-2 py-1 text-left">Min</th>
              <th className="px-2 py-1 text-left">Max</th>
              <th className="px-2 py-1 text-left">Label</th>
              <th className="px-2 py-1 text-left">Result</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.id} className="border-b border-subtle">
                <td className="px-2 py-1 font-mono">{r.rangeMin}</td>
                <td className="px-2 py-1 font-mono">{r.rangeMax}</td>
                <td className="px-2 py-1">{r.label}</td>
                <td className="px-2 py-1 text-fg-muted">{r.resultText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-muted">
        Row editing is in development — use the API directly to add/remove rows for now.{' '}
        <button type="button" className="underline" onClick={() => void onUpdated()}>
          Refresh
        </button>
      </p>
    </div>
  );
}
