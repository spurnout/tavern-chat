import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { useAuth } from '../lib/auth.js';
import { toast } from '../lib/toast.js';
import { AttachmentView } from './AttachmentView.js';
import { MemberProfileTrigger } from './MemberProfileTrigger.js';
import { ReactionBar } from './ReactionBar.js';
import { MessageEmbeds } from './MessageEmbeds.js';
import { MessageComponents } from './MessageComponents.js';
import { DiceRollMessage } from './MessageList.js';

interface Props {
  dmChannelId: string;
}

const EMPTY_MESSAGES: never[] = [];
const STICK_THRESHOLD_PX = 120;

export function DmMessageList({ dmChannelId }: Props): JSX.Element {
  const messagesByDmChannel = useRealtime((s) => s.messagesByDmChannel);
  const messages = messagesByDmChannel[dmChannelId] ?? EMPTY_MESSAGES;
  const setDmMessages = useRealtime((s) => s.setDmMessages);
  const me = useAuth((s) => s.me);

  const [loading, setLoading] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Message[]>(`/dms/${dmChannelId}/messages?limit=50`)
      .then((data) => {
        if (!cancelled) setDmMessages(dmChannelId, data);
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load this conversation. Try again in a moment.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dmChannelId, setDmMessages]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 8,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= STICK_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div
      ref={parentRef}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Messages"
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      {loading && messages.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-fg-muted">Loading…</div>
      ) : null}
      {!loading && messages.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-fg-muted">
          No messages yet. Say hello.
        </div>
      ) : null}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const message = messages[row.index];
          if (!message) return null;
          return (
            <div
              key={message.id}
              ref={virtualizer.measureElement}
              data-index={row.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start}px)`,
              }}
              className="group px-1 py-2"
            >
              <div className="flex items-baseline gap-2 text-sm">
                <MemberProfileTrigger
                  userId={message.authorId}
                  serverId={null}
                  side="right"
                  align="start"
                >
                  <button
                    type="button"
                    className="font-serif font-medium text-fg hover:underline focus:outline-none focus-visible:underline"
                  >
                    {message.author.displayName}
                  </button>
                </MemberProfileTrigger>
                <span className="font-mono text-[11px] text-fg-muted">
                  @{message.author.username}
                </span>
                <span className="text-[11px] text-fg-muted">
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {message.deletedAt ? (
                <div className="text-sm italic text-fg-muted">Message deleted</div>
              ) : message.type === 'dice_roll' ? (
                <>
                  <DiceRollMessage message={message} />
                  {me ? <ReactionBar message={message} /> : null}
                </>
              ) : (
                <>
                  <div className="whitespace-pre-wrap break-words text-sm text-fg">
                    {message.content}
                  </div>
                  {message.embeds && message.embeds.length > 0 ? (
                    <MessageEmbeds embeds={message.embeds} />
                  ) : null}
                  {message.components && message.components.length > 0 ? (
                    <MessageComponents messageId={message.id} rows={message.components} />
                  ) : null}
                  {message.attachmentIds.length > 0 ? (
                    <div className="mt-1 space-y-1">
                      {message.attachmentIds.map((aid) => (
                        <AttachmentView key={aid} id={aid} />
                      ))}
                    </div>
                  ) : null}
                  {me ? <ReactionBar message={message} /> : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
