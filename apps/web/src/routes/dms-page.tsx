import { useEffect } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Menu, MessageCircle, Plus, Users } from 'lucide-react';
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
  // Below `lg` the conversation list is a slide-in drawer (mirrors the member
  // roster idiom) so an open thread gets the full width on phones. Ignored at
  // `lg+`, where the list is a static column.
  const [listOpen, setListOpen] = useState(false);

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

  // FO-3: show a banner when the remote instance permanently refused delivery.
  const federationRefused = useRealtime(
    (s) => (active ? s.dmFederationRefusedByChannelId[active.id] === true : false),
  );

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1">
      {/* Drawer backdrop below lg. Hidden at lg+, where the list is a column. */}
      {listOpen ? (
        <button
          type="button"
          aria-label="Close conversations"
          className="fixed inset-0 z-10 bg-black/60 lg:hidden"
          onClick={() => setListOpen(false)}
        />
      ) : null}
      <aside
        className={cn(
          'absolute inset-y-0 left-0 z-20 flex w-64 shrink-0 flex-col border-r border-subtle bg-sunken transition-transform',
          'lg:static lg:z-auto lg:translate-x-0',
          listOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
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
              onNavigate={() => setListOpen(false)}
            />
          ))}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
              <button
                type="button"
                aria-label="Show conversations"
                onClick={() => setListOpen(true)}
                className="-ml-1 rounded p-1 text-fg-muted hover:bg-raised lg:hidden"
                title="Show conversations"
              >
                <Menu size={18} />
              </button>
              {active.kind === 'group' ? (
                <Users size={16} className="text-fg-muted" />
              ) : (
                <MessageCircle size={16} className="text-fg-muted" />
              )}
              <span className="font-serif font-medium">
                {describeDmChannel(active, me?.id ?? null)}
              </span>
            </header>
            {federationRefused && (
              <div className="flex items-center gap-2 border-b border-subtle bg-tint-ember px-4 py-2 text-sm text-fg">
                <span>Your message couldn't be delivered — the remote instance refused or is unreachable.</span>
              </div>
            )}
            <DmMessageList dmChannelId={active.id} />
            <DmMessageComposer dmChannelId={active.id} />
          </>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-fg-muted">
            <div className="flex flex-col items-center gap-3">
              <p>Pull up a chair — pick a conversation, or start a new one with the + button.</p>
              <button
                type="button"
                onClick={() => setListOpen(true)}
                className="inline-flex items-center gap-2 rounded border border-subtle px-3 py-1.5 text-fg hover:bg-raised lg:hidden"
              >
                <Menu size={16} aria-hidden />
                Show conversations
              </button>
            </div>
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
  onNavigate,
}: {
  channel: DmChannel;
  meId: string | null;
  active: boolean;
  /** Close the mobile drawer when a conversation is opened. */
  onNavigate: () => void;
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
      onClick={onNavigate}
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
