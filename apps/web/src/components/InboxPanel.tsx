import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { EmptyState } from './EmptyState.js';
import { useInbox } from '../lib/inbox-store.js';
import { useRealtime } from '../lib/store.js';
import { messagePreview } from '../lib/message-preview.js';

/**
 * Activity inbox bell. Shows the total unread @mention count and opens a
 * popover listing recent unread mentions. Clicking a mention navigates to
 * the room and acks it.
 */
export function InboxPanel(): JSX.Element {
  const totalUnread = useInbox((s) => s.totalUnreadMentions);
  const items = useInbox((s) => s.inboxItems);
  const loading = useInbox((s) => s.inboxLoading);
  const loadInbox = useInbox((s) => s.loadInbox);
  const ackMention = useInbox((s) => s.ackMention);
  const ackAll = useInbox((s) => s.ackAllMentions);

  const channelsByServer = useRealtime((s) => s.channelsByServer);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) void loadInbox(true);
  }, [open, loadInbox]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  function openMention(item: (typeof items)[number]): void {
    void ackMention(item.id);
    if (item.channelId) {
      for (const [serverId, channels] of Object.entries(channelsByServer)) {
        if (channels.some((c) => c.id === item.channelId)) {
          void navigate({
            to: '/app/servers/$serverId/channels/$channelId',
            params: { serverId, channelId: item.channelId },
          });
          break;
        }
      }
    } else if (item.dmChannelId) {
      void navigate({
        to: '/app/dms/$dmChannelId',
        params: { dmChannelId: item.dmChannelId },
      });
    }
    setOpen(false);
  }

  const unreadOnly = items.filter((i) => !i.isRead);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={
          totalUnread > 0
            ? `Activity inbox — ${totalUnread} unread mention${totalUnread === 1 ? '' : 's'}`
            : 'Activity inbox'
        }
        title="Activity inbox"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded p-1 hover:bg-raised"
      >
        <Bell size={16} />
        {totalUnread > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-ember px-1 text-center font-mono text-[10px] leading-[1.1rem] text-fg">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-0 z-40 mb-2 w-96 max-w-[90vw] rounded border border-subtle bg-surface shadow-lg"
          role="dialog"
          aria-label="Activity inbox"
        >
          <header className="flex items-center justify-between border-b border-subtle px-3 py-2">
            <h2 className="font-serif text-sm">Mentions</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void ackAll()}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-raised"
                title="Mark all as read"
                disabled={unreadOnly.length === 0}
              >
                <CheckCheck size={12} /> Mark all
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 hover:bg-raised"
                aria-label="Close"
              >
                <X size={12} />
              </button>
            </div>
          </header>
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <p className="px-3 py-4 text-sm text-fg-muted">Loading…</p>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<Bell size={28} strokeWidth={1.5} />}
                title="All quiet for now."
                description="When someone calls your name, it’ll show up here."
              />
            ) : (
              <ul>
                {items.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => openMention(m)}
                      className={`block w-full px-3 py-2 text-left text-sm hover:bg-raised ${
                        m.isRead ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium">{m.message.authorDisplayName}</span>
                        <span className="font-mono text-xs text-fg-muted">{tagFor(m.kind)}</span>
                        <span className="ml-auto text-xs text-fg-muted">{when(m.createdAt)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-fg-muted">{messagePreview(m.message)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function tagFor(kind: 'user' | 'role' | 'everyone' | 'here'): string {
  switch (kind) {
    case 'user':
      return 'mentioned you';
    case 'role':
      return 'role mention';
    case 'everyone':
      return '@everyone';
    case 'here':
      return '@here';
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h`;
  return d.toLocaleDateString();
}
