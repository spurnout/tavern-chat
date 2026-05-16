import { useEffect, useMemo, useState } from 'react';
import { useRealtime } from '../lib/store.js';

interface Props {
  channelId: string;
  text: string;
  /** Cursor offset into `text` — autocomplete only fires when @ is at cursor. */
  cursorOffset: number;
  onAccept: (text: string, cursorAt: number) => void;
}

interface Suggestion {
  kind: 'group' | 'role';
  label: string;
  /** What gets substituted into the text (e.g. "everyone", "GMs"). */
  token: string;
  description: string;
  warning?: boolean;
}

/**
 * Detect the active @-token at the cursor: an `@` followed by a partial
 * word, with nothing but the partial between `@` and the cursor.
 *
 * Returns the partial (without the `@`) and the start index of the `@`,
 * or null if the cursor isn't on a mention.
 */
function detectActiveAt(text: string, cursor: number): { partial: string; atIndex: number } | null {
  let i = cursor;
  while (i > 0) {
    const ch = text[i - 1];
    if (!ch) break;
    if (ch === '@') {
      const before: string | undefined = i >= 2 ? text[i - 2] : undefined;
      // The `@` must be at start of string or follow a whitespace/bracket.
      if (before === undefined || /[\s([{]/.test(before)) {
        return { partial: text.slice(i, cursor), atIndex: i - 1 };
      }
      return null;
    }
    if (!/[A-Za-z0-9_\-.]/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * Suggests @everyone, @here, and server roles when the user is typing an
 * @ mention. Members are handled by the MemberProfileCard "Mention in this
 * room" action; this popover focuses on the new group/role surface.
 */
export function MentionAutocomplete({
  channelId,
  text,
  cursorOffset,
  onAccept,
}: Props): JSX.Element | null {
  const channel = useRealtime((s) => {
    for (const list of Object.values(s.channelsByServer)) {
      const found = list.find((c) => c.id === channelId);
      if (found) return found;
    }
    return null;
  });
  const serverId = channel?.serverId ?? null;
  const roles = useRealtime((s) =>
    serverId ? (s.rolesByServerId[serverId]?.roles ?? []) : [],
  );
  const loadRolesForServer = useRealtime((s) => s.loadRolesForServer);
  const [active, setActive] = useState(0);

  // Lazy-load roles for the server the first time the user starts an @.
  const at = useMemo(() => detectActiveAt(text, cursorOffset), [text, cursorOffset]);

  useEffect(() => {
    if (at && serverId) void loadRolesForServer(serverId);
  }, [at, serverId, loadRolesForServer]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!at) return [];
    const partial = at.partial.toLowerCase();
    const all: Suggestion[] = [
      {
        kind: 'group',
        label: '@everyone',
        token: 'everyone',
        description: 'Notify everyone in this room',
        warning: true,
      },
      {
        kind: 'group',
        label: '@here',
        token: 'here',
        description: 'Notify online members only',
      },
      ...roles
        .filter((r) => !r.isEveryone)
        .map<Suggestion>((r) => ({
          kind: 'role',
          label: `@${r.name}`,
          token: r.name,
          description: r.mentionable ? 'Role — mentionable' : 'Role — requires MENTION_EVERYONE',
        })),
    ];
    if (!partial) return all;
    return all.filter((s) => s.token.toLowerCase().startsWith(partial));
  }, [at, roles]);

  useEffect(() => setActive(0), [at?.partial]);

  useEffect(() => {
    if (!at || suggestions.length === 0) return;
    function onKey(e: KeyboardEvent): void {
      if (!at) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const choice = suggestions[active];
        if (choice) accept(choice);
      }
    }
    function accept(choice: Suggestion): void {
      if (!at) return;
      const head = text.slice(0, at.atIndex);
      const tail = text.slice(cursorOffset);
      const insert = `@${choice.token} `;
      const next = `${head}${insert}${tail}`;
      onAccept(next, at.atIndex + insert.length);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [at, suggestions, active, text, cursorOffset, onAccept]);

  if (!at || suggestions.length === 0) return null;

  return (
    <div
      className="mb-2 max-h-64 overflow-y-auto rounded border border-subtle bg-surface shadow-lg"
      role="listbox"
      aria-label="Mention targets"
    >
      {suggestions.map((s, idx) => (
        <button
          key={`${s.kind}:${s.token}`}
          type="button"
          role="option"
          aria-selected={idx === active}
          onMouseEnter={() => setActive(idx)}
          onMouseDown={(e) => {
            e.preventDefault();
            const head = text.slice(0, at.atIndex);
            const tail = text.slice(cursorOffset);
            const insert = `@${s.token} `;
            onAccept(`${head}${insert}${tail}`, at.atIndex + insert.length);
          }}
          className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
            idx === active ? 'bg-raised' : ''
          }`}
        >
          <span className={`font-mono ${s.warning ? 'text-mead' : 'text-fg'}`}>{s.label}</span>
          <span className="ml-auto text-xs text-fg-muted">{s.description}</span>
        </button>
      ))}
    </div>
  );
}
