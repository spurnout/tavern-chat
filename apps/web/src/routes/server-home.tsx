import { useEffect } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useRealtime } from '../lib/store.js';
import { TavernLogo } from '../components/TavernLogo.js';

export function ServerHomePage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const channels = useRealtime((s) => (serverId ? (s.channelsByServer[serverId] ?? []) : []));
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
    <div className="grid h-full place-items-center p-12 text-center">
      <div className="max-w-md space-y-4">
        <TavernLogo className="justify-center" />
        <h1 className="text-2xl font-semibold">Welcome.</h1>
        <p className="text-sm text-tavern-mist">
          {channels.length === 0
            ? 'No channels yet — ask the server owner to create some.'
            : 'Pick a channel from the sidebar.'}
        </p>
      </div>
    </div>
  );
}
