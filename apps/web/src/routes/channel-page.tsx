import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Hash, Users } from 'lucide-react';
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
  // Roster is a static column at lg+, a right-side drawer below it. Local
  // state on purpose: ChannelPage doesn't remount on channel change, so the
  // drawer survives room-hopping (read members while switching rooms).
  const [membersOpen, setMembersOpen] = useState(false);

  useEffect(() => {
    if (!channelId || channel) return;
    api<Channel>(`/channels/${channelId}`)
      .then(upsertChannel)
      .catch(() => undefined);
  }, [channelId, channel, upsertChannel]);

  if (!channelId) return <div className="grid h-full place-items-center">Pick a room.</div>;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* pl-14 below md clears the app-shell's floating hamburger; symmetric
            px-4 returns once the hamburger is gone at md+. */}
        <header className="flex items-center gap-2 border-b border-subtle py-3 pl-14 pr-4 md:px-4">
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
            {serverId ? (
              <button
                type="button"
                aria-label="Toggle members"
                aria-expanded={membersOpen}
                aria-controls="member-sidebar"
                title="Members"
                onClick={() => setMembersOpen((v) => !v)}
                className="touch-target-sq rounded p-1 text-fg-muted hover:bg-raised lg:hidden"
              >
                <Users size={16} />
              </button>
            ) : null}
          </div>
        </header>
        <LiveSessionDock channelId={channelId} />
        <EncounterPanel channelId={channelId} />
        <MessageList channelId={channelId} />
        <TypingIndicator channelId={channelId} />
        <MessageComposer channelId={channelId} />
      </div>
      {serverId ? (
        <MemberSidebar
          serverId={serverId}
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}
    </div>
  );
}
