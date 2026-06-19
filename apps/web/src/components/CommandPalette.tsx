import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Flame,
  Gavel,
  Hash,
  Home,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import { useRealtime } from '../lib/store.js';
import {
  actionCommands,
  searchCommands,
  type PaletteEntry,
  type PaletteGroup,
  type PaletteIcon,
} from '../lib/palette-commands.js';

/**
 * Wave 3 #6 — Cmd/Ctrl+K command palette. Fuzzy-find across rooms, DMs, and
 * settings; trigger app-shell actions; search messages. Grouped into
 * **Jump to** / **Action** / **Search**.
 *
 * Built on Radix Dialog so it's a proper modal: focus trap, focus restore,
 * Escape-to-close, and scroll lock come for free. The internal arrow-key
 * navigation and grouping are unchanged.
 */
export function CommandPalette(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { serverId?: string };
  const serversById = useRealtime((s) => s.serversById);
  const channelsByServer = useRealtime((s) => s.channelsByServer);
  const dmChannelsById = useRealtime((s) => s.dmChannelsById);

  // Global Cmd/Ctrl+K toggle. Escape is handled by Radix Dialog now.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset the query + highlight each time the palette opens. Initial focus is
  // directed to the input via Dialog's onOpenAutoFocus below.
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const jumpEntries = useMemo<PaletteEntry[]>(() => {
    const out: PaletteEntry[] = [
      {
        id: 'jump:home',
        group: 'jump',
        label: 'Home',
        hint: 'Taverns index',
        icon: 'home',
        go: () => void navigate({ to: '/app' }),
      },
      {
        id: 'jump:dms',
        group: 'jump',
        label: 'Direct messages',
        hint: 'DMs',
        icon: 'dm',
        go: () => void navigate({ to: '/app/dms' }),
      },
      {
        id: 'jump:account',
        group: 'jump',
        label: 'Account settings',
        hint: '2FA, sessions, data, themes',
        icon: 'settings',
        go: () => void navigate({ to: '/app/account' }),
      },
    ];
    for (const [serverId, channels] of Object.entries(channelsByServer)) {
      const serverName = serversById[serverId]?.name ?? '…';
      for (const c of channels) {
        if (c.type === 'voice' || c.type === 'category') continue;
        out.push({
          id: `jump:room:${c.id}`,
          group: 'jump',
          label: `#${c.name}`,
          hint: serverName,
          icon: 'hash',
          go: () =>
            void navigate({
              to: '/app/servers/$serverId/channels/$channelId',
              params: { serverId, channelId: c.id },
            }),
        });
      }
    }
    for (const dm of Object.values(dmChannelsById)) {
      out.push({
        id: `jump:dm:${dm.id}`,
        group: 'jump',
        label: dm.name ?? 'DM',
        hint: 'Direct message',
        icon: 'dm',
        go: () =>
          void navigate({
            to: '/app/dms/$dmChannelId',
            params: { dmChannelId: dm.id },
          }),
      });
    }
    return out;
  }, [serversById, channelsByServer, dmChannelsById, navigate]);

  const actionEntries = useMemo<PaletteEntry[]>(
    () => actionCommands({ navigate, activeServerId: params.serverId ?? null }),
    [navigate, params.serverId],
  );

  const searchEntries = useMemo<PaletteEntry[]>(
    () => searchCommands({ navigate, activeServerId: params.serverId ?? null, query: q }),
    [navigate, params.serverId, q],
  );

  const filtered = useMemo<PaletteEntry[]>(() => {
    const needle = q.trim().toLowerCase();
    function match(e: PaletteEntry): boolean {
      if (!needle) return true;
      return `${e.label} ${e.hint ?? ''}`.toLowerCase().includes(needle);
    }
    // Search items always appear at the bottom when the query is non-empty.
    const jumps = jumpEntries.filter(match).slice(0, 25);
    const actions = actionEntries.filter(match);
    return [...jumps, ...actions, ...searchEntries];
  }, [jumpEntries, actionEntries, searchEntries, q]);

  useEffect(() => setActive(0), [q]);

  const grouped = groupBy(filtered);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed left-1/2 top-[10vh] z-50 w-full max-w-xl -translate-x-1/2 rounded-lg border border-subtle bg-surface shadow-xl"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <header className="flex items-center gap-2 border-b border-subtle px-3 py-2">
            <Search size={14} className="text-fg-muted" />
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a room, member, message, or action…"
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-controls="command-palette-list"
              aria-activedescendant={
                filtered[active] ? optionDomId(filtered[active].id) : undefined
              }
              className="flex-1 rounded bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-ember"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const choice = filtered[active];
                  if (choice) {
                    choice.go();
                    setOpen(false);
                  }
                }
              }}
            />
            <Dialog.Close className="rounded p-1 hover:bg-raised" aria-label="Close">
              <X size={12} />
            </Dialog.Close>
          </header>
          <p className="sr-only" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
          </p>
          <div
            id="command-palette-list"
            role="listbox"
            aria-label="Command palette results"
            className="max-h-96 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-sm text-fg-muted">No matches.</p>
            ) : null}
            {(['jump', 'action', 'search'] as const).map((g) =>
              grouped[g].length === 0 ? null : (
                <section key={g} role="presentation">
                  <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                    {labelForGroup(g)}
                  </div>
                  <ul role="presentation">
                    {grouped[g].map((e) => {
                      const idx = filtered.indexOf(e);
                      return (
                        <li key={e.id} role="presentation">
                          <button
                            type="button"
                            id={optionDomId(e.id)}
                            role="option"
                            aria-selected={idx === active}
                            onMouseEnter={() => setActive(idx)}
                            onClick={() => {
                              e.go();
                              setOpen(false);
                            }}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                              idx === active ? 'bg-tint-ember text-ember-hi' : 'text-fg-muted'
                            }`}
                          >
                            <IconFor name={e.icon} active={idx === active} />
                            <span className={idx === active ? 'text-ember-hi' : 'text-fg'}>
                              {e.label}
                            </span>
                            {e.hint ? (
                              <span className="ml-auto truncate text-xs text-fg-faint">
                                {e.hint}
                              </span>
                            ) : null}
                            {e.kbd ? (
                              <kbd className="ml-2 rounded border border-subtle bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-fg-faint">
                                {e.kbd}
                              </kbd>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ),
            )}
          </div>
          <footer className="border-t border-subtle px-3 py-1.5 text-xs text-fg-muted">
            <span className="font-mono">↑ ↓</span> to navigate ·{' '}
            <span className="font-mono">Enter</span> to open ·{' '}
            <span className="font-mono">Esc</span> to close
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Stable DOM id for a result row, derived from the entry's own id. Used by the
 * input's `aria-activedescendant` and each `role="option"` element so screen
 * readers can follow the arrow-key highlight. Non-`[A-Za-z0-9_-]` characters
 * (e.g. the `:` in `jump:room:…`) are replaced so the value is a safe IDREF.
 */
function optionDomId(entryId: string): string {
  return `command-palette-option-${entryId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function groupBy(entries: PaletteEntry[]): Record<PaletteGroup, PaletteEntry[]> {
  const out: Record<PaletteGroup, PaletteEntry[]> = { jump: [], action: [], search: [] };
  for (const e of entries) out[e.group].push(e);
  return out;
}

function labelForGroup(group: PaletteGroup): string {
  switch (group) {
    case 'jump':
      return 'Jump to';
    case 'action':
      return 'Action';
    case 'search':
      return 'Search';
  }
}

function IconFor({ name, active }: { name: PaletteIcon; active: boolean }): JSX.Element {
  const size = 14;
  const className = active ? 'text-ember' : 'text-fg-muted';
  switch (name) {
    case 'hash':
      return <Hash size={size} className={className} />;
    case 'dm':
      return <MessageCircle size={size} className={className} />;
    case 'settings':
      return <Settings size={size} className={className} />;
    case 'search':
      return <Search size={size} className={className} />;
    case 'plus':
      return <Plus size={size} className={className} />;
    case 'flame':
      return <Flame size={size} className={className} />;
    case 'gavel':
      return <Gavel size={size} className={className} />;
    case 'shield':
      return <Shield size={size} className={className} />;
    case 'sparkles':
      return <Sparkles size={size} className={className} />;
    default:
      return <Home size={size} className={className} />;
  }
}
