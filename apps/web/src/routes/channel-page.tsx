import { useEffect } from 'react';
import { useParams } from '@tanstack/react-router';
import { Hash } from 'lucide-react';
import { MessageList } from '../components/MessageList.js';
import { MessageComposer } from '../components/MessageComposer.js';
import { MemberSidebar } from '../components/MemberSidebar.js';
import { TypingIndicator } from '../components/TypingIndicator.js';
import { PinsPopover } from '../components/PinsPopover.js';
import { EncounterPanel } from '../components/EncounterPanel.js';
import { LiveSessionDock } from '../components/LiveSessionDock.js';
import { ChannelSettingsPopover } from '../components/ChannelSettingsPopover.js';
import { useCanIn } from '../lib/store.js';
import { Permission } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import type { Channel } from '@tavern/shared';

export function ChannelPage(): JSX.Element {
  const params = useParams({ strict: false }) as {
    serverId?: string;
    channelId?: string;
  };
  const channelId = params.channelId;
  const serverId = params.serverId;

  const channel = useRealtime((s) => {
    if (!channelId) return null;
    for (const list of Object.values(s.channelsByServer)) {
      const c = list.find((c) => c.id === channelId);
      if (c) return c;
    }
    return null;
  });
  const upsertChannel = useRealtime((s) => s.upsertChannel);
  const canManageChannel = useCanIn(serverId ?? null, Permission.MANAGE_CHANNELS);

  useEffect(() => {
    if (!channelId || channel) return;
    api<Channel>(`/channels/${channelId}`)
      .then(upsertChannel)
      .catch(() => undefined);
  }, [channelId, channel, upsertChannel]);

  if (!channelId) return <div className="grid h-full place-items-center">Pick a room.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
          <Hash size={16} className="text-fg-muted" />
          <span className="font-serif font-medium">{channel?.name ?? '…'}</span>
          {channel?.topic ? (
            <span className="ml-3 truncate text-sm text-fg-muted">{channel.topic}</span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <PinsPopover channelId={channelId} />
            {channel ? (
              <ChannelSettingsPopover
                channel={channel}
                canManage={canManageChannel}
              />
            ) : null}
          </div>
        </header>
        <LiveSessionDock channelId={channelId} />
        <EncounterPanel channelId={channelId} />
        <MessageList channelId={channelId} />
        <TypingIndicator channelId={channelId} />
        <MessageComposer channelId={channelId} />
      </div>
      {serverId ? <MemberSidebar serverId={serverId} /> : null}
    </div>
  );
}
