import { useEffect } from 'react';
import { useParams } from '@tanstack/react-router';
import { Hash } from 'lucide-react';
import { MessageList } from '../components/MessageList.js';
import { MessageComposer } from '../components/MessageComposer.js';
import { api } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import type { Channel } from '@tavern/shared';

export function ChannelPage(): JSX.Element {
  const params = useParams({ strict: false }) as { channelId?: string };
  const channelId = params.channelId;
  const channel = useRealtime((s) => {
    if (!channelId) return null;
    for (const list of Object.values(s.channelsByServer)) {
      const c = list.find((c) => c.id === channelId);
      if (c) return c;
    }
    return null;
  });
  const upsertChannel = useRealtime((s) => s.upsertChannel);

  useEffect(() => {
    if (!channelId || channel) return;
    api<Channel>(`/channels/${channelId}`)
      .then(upsertChannel)
      .catch(() => undefined);
  }, [channelId, channel, upsertChannel]);

  if (!channelId) return <div className="grid h-full place-items-center">Pick a channel.</div>;

  return (
    <>
      <header className="flex items-center gap-2 border-b border-tavern-oak px-4 py-3">
        <Hash size={16} className="text-tavern-mist" />
        <span className="font-semibold">{channel?.name ?? '…'}</span>
        {channel?.topic ? (
          <span className="ml-3 truncate text-sm text-tavern-mist">{channel.topic}</span>
        ) : null}
      </header>
      <MessageList channelId={channelId} />
      <MessageComposer channelId={channelId} />
    </>
  );
}
