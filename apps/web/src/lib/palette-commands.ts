import type { useNavigate } from '@tanstack/react-router';
import { emitUi } from './ui-events.js';

export type PaletteGroup = 'jump' | 'action' | 'search';
export type PaletteIcon =
  | 'home'
  | 'hash'
  | 'dm'
  | 'settings'
  | 'search'
  | 'plus'
  | 'flame'
  | 'gavel'
  | 'shield'
  | 'sparkles';

export interface PaletteEntry {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  icon: PaletteIcon;
  kbd?: string;
  go: () => void;
}

interface ActionDeps {
  navigate: ReturnType<typeof useNavigate>;
  activeServerId: string | null;
}

/**
 * Returns the static "Action" group — items that trigger app-shell modals or
 * navigate to a known surface. Items are filtered by whether they need an
 * active server context (e.g. opening a room only makes sense inside a den).
 */
export function actionCommands({ navigate, activeServerId }: ActionDeps): PaletteEntry[] {
  const out: PaletteEntry[] = [];

  out.push({
    id: 'action:create-server',
    group: 'action',
    label: 'Light a new hearth…',
    hint: 'Create a new tavern',
    icon: 'flame',
    go: () => emitUi({ kind: 'open-create-server' }),
  });

  if (activeServerId) {
    out.push({
      id: 'action:create-channel',
      group: 'action',
      label: 'Open a new room…',
      hint: 'Add a room to this tavern',
      icon: 'plus',
      kbd: '⌘N',
      go: () => emitUi({ kind: 'open-create-channel' }),
    });

    out.push({
      id: 'action:audit-log',
      group: 'action',
      label: 'Open the audit log…',
      hint: 'Recent actions in this tavern',
      icon: 'shield',
      go: () =>
        void navigate({
          to: '/app/servers/$serverId/moderation',
          params: { serverId: activeServerId },
          search: { tab: 'audit' } as never,
        }),
    });

    out.push({
      id: 'action:ban-member',
      group: 'action',
      label: 'Ask someone to leave…',
      hint: 'Remove a member from this tavern',
      icon: 'gavel',
      go: () =>
        void navigate({
          to: '/app/servers/$serverId/settings',
          params: { serverId: activeServerId },
          search: { tab: 'bans', action: 'ban' } as never,
        }),
    });

    out.push({
      id: 'action:campaigns',
      group: 'action',
      label: 'Schedule the next session…',
      hint: 'Plan a campaign session',
      icon: 'sparkles',
      go: () =>
        void navigate({
          to: '/app/servers/$serverId/campaigns',
          params: { serverId: activeServerId },
        }),
    });
  }

  out.push({
    id: 'action:notifications',
    group: 'action',
    label: 'Notification settings…',
    hint: 'Per-tavern notifications',
    icon: 'settings',
    go: () => emitUi({ kind: 'open-notification-settings' }),
  });

  return out;
}

interface SearchDeps {
  navigate: ReturnType<typeof useNavigate>;
  activeServerId: string | null;
  query: string;
}

/**
 * When the user has typed a non-empty query and there's an active server,
 * surface a "Search messages for «X»" item that hands off to the server's
 * search page with the query preserved.
 */
export function searchCommands({ navigate, activeServerId, query }: SearchDeps): PaletteEntry[] {
  const trimmed = query.trim();
  if (!trimmed || !activeServerId) return [];
  return [
    {
      id: 'search:messages',
      group: 'search',
      label: `Search messages for “${trimmed}”`,
      hint: 'Across all rooms in this tavern',
      icon: 'search',
      go: () =>
        void navigate({
          to: '/app/servers/$serverId/search',
          params: { serverId: activeServerId },
          search: { q: trimmed } as never,
        }),
    },
  ];
}
