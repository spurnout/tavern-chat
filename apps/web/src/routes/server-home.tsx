import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useRealtime } from '../lib/store.js';
import { EmptyState } from '../components/EmptyState.js';
import { TavernLogo } from '../components/TavernLogo.js';

const EMPTY_CHANNELS: never[] = [];

export function ServerHomePage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  // Subscribe to the dict; `?? []` would otherwise return a fresh array on
  // every getSnapshot read and infinite-loop React's useSyncExternalStore.
  const channelsByServer = useRealtime((s) => s.channelsByServer);
  const channels = useMemo(
    () => (serverId ? (channelsByServer[serverId] ?? EMPTY_CHANNELS) : EMPTY_CHANNELS),
    [channelsByServer, serverId],
  );
  const navigate = useNavigate();

  // Auto-select first text channel when one shows up.
  useEffect(() => {
    if (!serverId) return;
    const text = channels.find((c) => c.type === 'text');
    if (text) {
      void navigate({
        to: '/app/servers/$serverId/channels/$channelId',
        params: { serverId, channelId: text.id },
        replace: true,
      });
    }
  }, [channels, serverId, navigate]);

  return (
    <EmptyState
      icon={<TavernLogo className="justify-center" />}
      title="Welcome."
      description={
        channels.length === 0
          ? 'No rooms yet — ask the tavern owner to create some.'
          : 'Pick a room from the sidebar.'
      }
    />
  );
}
