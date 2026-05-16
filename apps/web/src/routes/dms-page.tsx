import { useEffect } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { MessageCircle, Plus, Users } from 'lucide-react';
import type { DmChannel } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { useAuth } from '../lib/auth.js';
import { useRealtime } from '../lib/store.js';
import { cn } from '../lib/cn.js';
import { DmMessageList } from '../components/DmMessageList.js';
import { DmMessageComposer } from '../components/DmMessageComposer.js';
import { PresenceDot } from '../components/PresenceDot.js';
import { useState } from 'react';
import { StartDmModal } from '../components/StartDmModal.js';

/**
 * The DMs route: a two-column view with the user's DM channel list on the
 * left and the active thread on the right. Both `/app/dms` (no thread
 * selected) and `/app/dms/$dmChannelId` (thread open) render through this
 * component — the URL param is the only difference.
 */
export function DmsPage(): JSX.Element {
  const params = useParams({ strict: false }) as { dmChannelId?: string };
  const me = useAuth((s) => s.me);

  const dmChannels = useRealtime((s) => s.dmChannelsById);
  const setActiveDmChannelId = useRealtime((s) => s.setActiveDmChannelId);
  const upsertDmChannel = useRealtime((s) => s.upsertDmChannel);

  const [startOpen, setStartOpen] = useState(false);

  // Initial fetch — gateway events keep us fresh from here.
  useEffect(() => {
    api<DmChannel[]>('/dms')
      .then((list) => {
        for (const c of list) upsertDmChannel(c);
      })
      .catch(() => undefined);
  }, [upsertDmChannel]);

  // Mirror the active DM into the store so the chat-sound gate can
  // suppress the chime when the user is staring at the thread.
  useEffect(() => {
    setActiveDmChannelId(params.dmChannelId ?? null);
    return () => setActiveDmChannelId(null);
  }, [params.dmChannelId, setActiveDmChannelId]);

  const ordered = Object.values(dmChannels).sort((a, b) => {
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return tb - ta;
  });

  const active = params.dmChannelId ? dmChannels[params.dmChannelId] : null;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-subtle bg-sunken">
        <div className="flex items-center justify-between border-b border-subtle px-3 py-2">
          <div className="flex items-center gap-2">
            <MessageCircle size={14} className="text-fg-muted" />
            <span className="font-serif text-sm font-medium">Direct messages</span>
          </div>
          <button
            type="button"
            aria-label="Start a new DM"
            onClick={() => setStartOpen(true)}
            className="rounded p-1 text-fg-muted hover:bg-raised"
            title="Start a new DM"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-sm">
          {ordered.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-xs text-fg-muted">
              No conversations yet.
              <br />
              Click + to start one.
            </div>
          ) : null}
          {ordered.map((c) => (
            <DmListItem
              key={c.id}
              channel={c}
              meId={me?.id ?? null}
              active={c.id === params.dmChannelId}
            />
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
              {active.kind === 'group' ? (
                <Users size={16} className="text-fg-muted" />
              ) : (
                <MessageCircle size={16} className="text-fg-muted" />
              )}
              <span className="font-serif font-medium">
                {describeDmChannel(active, me?.id ?? null)}
              </span>
            </header>
            <DmMessageList dmChannelId={active.id} />
            <DmMessageComposer dmChannelId={active.id} />
          </>
        ) : (
          <div className="grid h-full place-items-center text-sm text-fg-muted">
            Pick a conversation, or start a new one with the + button.
          </div>
        )}
      </div>

      <StartDmModal open={startOpen} onOpenChange={setStartOpen} />
    </div>
  );
}

function DmListItem({
  channel,
  meId,
  active,
}: {
  channel: DmChannel;
  meId: string | null;
  active: boolean;
}): JSX.Element {
  const other =
    channel.kind === 'direct' && meId
      ? channel.members.find((m) => m.userId !== meId)
      : null;
  const presenceByUserId = useRealtime((s) => s.presenceByUserId);
  const otherPresence = other ? (presenceByUserId[other.userId] ?? other.user.presence) : null;
  return (
    <Link
      to="/app/dms/$dmChannelId"
      params={{ dmChannelId: channel.id }}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5',
        active ? 'bg-raised' : 'hover:bg-raised',
      )}
    >
      <div className="relative shrink-0">
        <div className="grid h-7 w-7 place-items-center rounded-full bg-raised font-serif text-xs font-semibold">
          {channel.kind === 'group' ? '#' : (other?.user.displayName ?? '?').slice(0, 2).toUpperCase()}
        </div>
        {otherPresence ? (
          <PresenceDot
            presence={otherPresence}
            className="absolute -bottom-0.5 -right-0.5"
          />
        ) : null}
      </div>
      <span className="truncate font-serif text-sm">
        {describeDmChannel(channel, meId)}
      </span>
    </Link>
  );
}

function describeDmChannel(channel: DmChannel, meId: string | null): string {
  if (channel.kind === 'direct' && meId) {
    const other = channel.members.find((m) => m.userId !== meId);
    return other?.user.displayName ?? 'Direct message';
  }
  if (channel.name) return channel.name;
  // Auto-name a group by listing its non-self members.
  const others = channel.members.filter((m) => m.userId !== meId);
  return others.map((m) => m.user.displayName).join(', ') || 'Group';
}
