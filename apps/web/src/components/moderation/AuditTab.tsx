import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { AuditLogEntry } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';
import { cn } from '../../lib/cn.js';
import { AUDIT_CATEGORIES, metaFor, type AuditCategory } from '../../lib/audit-actions.js';
import { AuditRow } from './AuditRow.js';

interface Props {
  serverId: string;
}

export function AuditTab({ serverId }: Props): JSX.Element {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<AuditCategory | 'all'>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    setLoading(true);
    // PERF: cap the page size client-side so an active server's audit log
    // doesn't render thousands of rows at once (no virtualization here).
    // The server still controls the page count via its own default, but the
    // explicit `?limit=200` keeps the UI snappy and the filter cheap.
    api<AuditLogEntry[]>(`/servers/${serverId}/audit-log?limit=200`)
      .then(setEntries)
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : 'Could not load audit log'),
      )
      .finally(() => setLoading(false));
  }, [serverId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (category !== 'all' && metaFor(e.action).category !== category) return false;
      if (needle) {
        const hay = `${e.action} ${e.actorDisplayName ?? ''} ${e.actorUsername ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [entries, category, q]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {AUDIT_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCategory(c.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              category === c.id
                ? 'border-ember bg-tint-ember text-ember-hi'
                : 'border-subtle text-fg-muted hover:bg-raised',
            )}
          >
            {c.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 rounded border border-subtle bg-canvas px-2">
          <Search size={12} className="text-fg-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search audit…"
            className="w-48 bg-transparent py-1 text-xs outline-none placeholder:text-fg-faint"
          />
        </div>
      </div>

      <div className="rounded border border-subtle bg-surface">
        {loading ? (
          <p className="p-6 text-sm text-fg-muted">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-6 text-sm text-fg-muted">
            {entries.length === 0
              ? 'No audit entries yet.'
              : 'No entries match this filter.'}
          </p>
        ) : (
          <ul>
            {filtered.map((e) => (
              <AuditRow key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
