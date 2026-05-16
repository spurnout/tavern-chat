import { useEffect, useMemo, useState } from 'react';
import { SLASH_CATALOG } from '@tavern/shared';
import { api } from '../lib/api-client.js';

interface CatalogEntry {
  name: string;
  description: string;
  argsHint: string;
  clientAction?: string;
}

interface Props {
  channelId: string;
  /** The current composer text. */
  text: string;
  /** Called when the user accepts a suggestion. The full replacement text. */
  onAccept: (text: string) => void;
  /** Called when the user closes the autocomplete without selecting. */
  onDismiss: () => void;
}

/**
 * Renders an autocomplete popover above the composer when the input starts
 * with `/`. Filters the server-side catalog by typed prefix and dispatches
 * the chosen entry back to the composer.
 *
 * Keyboard handled here: ArrowUp / ArrowDown / Enter / Escape. The composer
 * forwards those keys via a window-level KeyboardEvent on the textarea.
 */
export function SlashAutocomplete({ channelId, text, onAccept, onDismiss }: Props): JSX.Element | null {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [active, setActive] = useState(0);

  const parsed = useMemo(() => {
    if (!text.startsWith('/')) return null;
    const trimmed = text.trimStart();
    const space = trimmed.indexOf(' ');
    const head = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
    return { head: head.toLowerCase(), hasArgs: space !== -1 };
  }, [text]);

  const parsedActive = Boolean(parsed);
  useEffect(() => {
    if (!parsedActive) {
      setCatalog(null);
      return;
    }
    let cancelled = false;
    api<{ commands: CatalogEntry[] }>(`/channels/${channelId}/slash/commands`)
      .then((res) => {
        if (!cancelled) setCatalog(res.commands);
      })
      .catch(() => {
        // Fall back to the static catalog if the catalog endpoint fails — the
        // server still enforces permissions when the command actually runs.
        if (!cancelled) {
          setCatalog(
            SLASH_CATALOG.map((e) => ({
              name: e.name,
              description: e.description,
              argsHint: e.argsHint,
              ...(e.clientAction ? { clientAction: e.clientAction } : {}),
            })),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, parsedActive]);

  const filtered = useMemo(() => {
    if (!parsed || !catalog) return [];
    if (parsed.hasArgs) {
      // Once the user types args after the command name, only show an exact
      // match (so the autocomplete becomes a single-row hint).
      const match = catalog.find((c) => c.name === parsed.head);
      return match ? [match] : [];
    }
    return catalog.filter((c) => c.name.startsWith(parsed.head));
  }, [catalog, parsed]);

  useEffect(() => {
    setActive(0);
  }, [parsed?.head]);

  useEffect(() => {
    if (!parsed) return;
    function onKey(e: KeyboardEvent): void {
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const entry = filtered[active];
        if (entry) onAccept(`/${entry.name} `);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filtered, active, parsed, onAccept, onDismiss]);

  if (!parsed || filtered.length === 0) return null;

  return (
    <div
      className="mb-2 max-h-64 overflow-y-auto rounded border border-subtle bg-surface shadow-lg"
      role="listbox"
      aria-label="Slash commands"
    >
      {filtered.map((entry, idx) => (
        <button
          key={entry.name}
          type="button"
          role="option"
          aria-selected={idx === active}
          onMouseEnter={() => setActive(idx)}
          onMouseDown={(e) => {
            e.preventDefault();
            onAccept(`/${entry.name} `);
          }}
          className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
            idx === active ? 'bg-raised' : ''
          }`}
        >
          <span className="font-mono text-fg">/{entry.name}</span>
          {entry.argsHint ? (
            <span className="font-mono text-xs text-fg-muted">{entry.argsHint}</span>
          ) : null}
          <span className="ml-auto text-xs text-fg-muted">{entry.description}</span>
        </button>
      ))}
    </div>
  );
}
