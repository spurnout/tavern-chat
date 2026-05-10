import { useNavigate, useParams } from '@tanstack/react-router';
import { VoiceRoom } from '../components/VoiceRoom.js';
import { useRealtime } from '../lib/store.js';

export function VoicePage(): JSX.Element {
  const { serverId, channelId } = useParams({ strict: false }) as {
    serverId?: string;
    channelId?: string;
  };
  const navigate = useNavigate();
  const channel = useRealtime((s) => {
    if (!channelId || !serverId) return null;
    return (s.channelsByServer[serverId] ?? []).find((c) => c.id === channelId) ?? null;
  });

  if (!serverId || !channelId) {
    return <div className="grid h-full place-items-center">Pick a voice room.</div>;
  }

  return (
    <VoiceRoom
      channelId={channelId}
      channelName={channel?.name ?? 'voice'}
      onLeave={() => void navigate({ to: '/app/servers/$serverId', params: { serverId } })}
    />
  );
}
