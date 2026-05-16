import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bookmark, Dice5, Flag, Forward, History, MessageSquare, Pin, Trash2 } from 'lucide-react';
import type { Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { useInbox } from '../lib/inbox-store.js';
import { useAuth } from '../lib/auth.js';
import { ThreadPanel } from './ThreadPanel.js';
import { PollMessage } from './PollMessage.js';
import { MessageContent } from './MessageContent.js';
import { ReplyContext } from './ReplyContext.js';
import { LinkPreviewCard } from './LinkPreviewCard.js';
import { ForwardMessageModal } from './ForwardMessageModal.js';
import { MessageEditHistoryModal } from './MessageEditHistoryModal.js';
import { toast } from '../lib/toast.js';
import { AttachmentView } from './AttachmentView.js';
import { MemberProfileTrigger } from './MemberProfileTrigger.js';
import { ReactionBar } from './ReactionBar.js';
import { ReportDialog } from './ReportDialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface Props {
  channelId: string;
}

const EMPTY_MESSAGES: never[] = [];

/**
 * Threshold for the sticky-scroll behaviour: if the user is within this many
 * pixels of the bottom we follow new messages; further up we leave them
 * where they are. FE-07.
 */
const STICK_THRESHOLD_PX = 120;

export function MessageList({ channelId }: Props): JSX.Element {
  // Subscribe to the dict; the `?? []` fallback would otherwise return a
  // fresh array each getSnapshot read and trip React's useSyncExternalStore.
  const messagesByChannel = useRealtime((s) => s.messagesByChannel);
  const messages = messagesByChannel[channelId] ?? EMPTY_MESSAGES;
  const setMessages = useRealtime((s) => s.setMessages);
  const me = useAuth((s) => s.me);

  const [loading, setLoading] = useState(false);
  const [reportTarget, setReportTarget] = useState<Message | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [activeThread, setActiveThread] = useState<{ id: string; root: Message } | null>(null);
  const [forwardTarget, setForwardTarget] = useState<Message | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Message | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  async function openThread(message: Message): Promise<void> {
    try {
      const thread = await api<{ id: string }>(
        `/channels/${channelId}/messages/${message.id}/threads`,
        { method: 'POST', body: {} },
      );
      setActiveThread({ id: thread.id, root: message });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not open thread');
    }
  }

  async function pin(message: Message): Promise<void> {
    try {
      await api(`/channels/${channelId}/pins/${message.id}`, { method: 'POST', body: {} });
      toast.info('Pinned.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not pin');
    }
  }

  async function save(message: Message): Promise<void> {
    try {
      await api(`/me/saved/${message.id}`, { method: 'POST', body: {} });
      toast.info('Saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Message[]>(`/channels/${channelId}/messages?limit=50`)
      .then((data) => {
        if (!cancelled) setMessages(channelId, data);
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load messages. Try again in a moment.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, setMessages]);

  // FE-08: drop the no-op useMemo over `messages` (deps:[messages] meant it
  // recomputed every render anyway). Just consume the array directly.
  const sorted = messages;

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 8,
  });

  // FE-07: sticky scroll-to-bottom — only follow new messages when the user
  // is already near the bottom. Previously every incoming message yanked the
  // viewport to the bottom even if the user was scrolled up reading history.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= STICK_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sorted.length]);

  // Phase 1.3 — auto-ACK the channel when the user is looking at it and a
  // new message arrives. We only fire when the active channel matches and
  // the most recent message id changes; ackChannel is a no-op if the cursor
  // is already up to date, so this is safe to call eagerly.
  const activeChannelId = useRealtime((s) => s.activeChannelId);
  const isAppFocused = useRealtime((s) => s.isAppFocused);
  const ackChannel = useInbox((s) => s.ackChannel);
  const lastMessageId = sorted.length > 0 ? sorted[sorted.length - 1]?.id ?? null : null;
  useEffect(() => {
    if (!lastMessageId) return;
    if (activeChannelId !== channelId) return;
    if (!isAppFocused) return;
    void ackChannel(channelId, lastMessageId);
  }, [channelId, lastMessageId, activeChannelId, isAppFocused, ackChannel]);

  return (
    <div
      ref={parentRef}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Messages"
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      {loading && sorted.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-fg-muted">Loading…</div>
      ) : null}
      {!loading && sorted.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-fg-muted">
          No messages yet. Start the conversation.
        </div>
      ) : null}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const message = sorted[row.index];
          if (!message) return null;
          return (
            <div
              key={message.id}
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${row.start}px)`, paddingBottom: '0.5rem' }}
              ref={virtualizer.measureElement}
              data-index={row.index}
              data-message-id={message.id}
            >
              <MessageRow
                message={message}
                mine={me?.id === message.authorId}
                onReport={() => setReportTarget(message)}
                onDelete={() => setDeleteTarget(message)}
                onOpenThread={() => void openThread(message)}
                onPin={() => void pin(message)}
                onSave={() => void save(message)}
                onForward={() => setForwardTarget(message)}
                onShowHistory={() => setHistoryTarget(message)}
              />
            </div>
          );
        })}
      </div>
      {reportTarget ? (
        <ReportDialog
          targetType="message"
          targetId={reportTarget.id}
          serverId={reportTarget.serverId}
          onClose={() => setReportTarget(null)}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          title="Delete this message?"
          description="The message will be removed for everyone in this room."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            try {
              await api(`/messages/${id}`, { method: 'DELETE' });
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not delete the message.');
            }
          }}
        />
      ) : null}
      {activeThread ? (
        <div className="absolute inset-y-0 right-0 z-30">
          <ThreadPanel
            threadId={activeThread.id}
            rootMessage={activeThread.root}
            onClose={() => setActiveThread(null)}
          />
        </div>
      ) : null}
      {forwardTarget ? (
        <ForwardMessageModal source={forwardTarget} onClose={() => setForwardTarget(null)} />
      ) : null}
      {historyTarget ? (
        <MessageEditHistoryModal
          messageId={historyTarget.id}
          currentContent={historyTarget.content}
          onClose={() => setHistoryTarget(null)}
        />
      ) : null}
    </div>
  );
}

interface RowProps {
  message: Message;
  mine: boolean;
  onReport: () => void;
  onDelete: () => void;
  onOpenThread: () => void;
  onPin: () => void;
  onSave: () => void;
  onForward: () => void;
  onShowHistory: () => void;
}

function MessageRow({
  message,
  mine,
  onReport,
  onDelete,
  onOpenThread,
  onPin,
  onSave,
  onForward,
  onShowHistory,
}: RowProps): JSX.Element {
  if (message.deletedAt) {
    return (
      <div className="rounded px-3 py-2 text-sm italic text-fg-muted">message deleted</div>
    );
  }
  if (message.type === 'dice_roll') {
    return (
      <div className="rounded-md border border-subtle bg-surface px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-mead">
          <Dice5 size={16} />
          <span className="font-mono">{message.content}</span>
        </div>
      </div>
    );
  }
  if (message.type === 'system') {
    return (
      <div className="px-3 py-1 text-sm italic text-fg-muted">{message.content}</div>
    );
  }
  return (
    <div className="group flex items-start gap-3 rounded px-2 py-1.5 hover:bg-tint-fg-04">
      <MemberProfileTrigger
        userId={message.authorId}
        serverId={message.serverId}
        side="right"
        align="start"
      >
        <button
          type="button"
          aria-label={`View profile of ${message.author.displayName}`}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised font-serif text-sm font-semibold focus:outline-none focus-visible:ring-1 focus-visible:ring-ember"
        >
          {message.author.displayName.slice(0, 2).toUpperCase()}
        </button>
      </MemberProfileTrigger>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          <MemberProfileTrigger
            userId={message.authorId}
            serverId={message.serverId}
            side="right"
            align="start"
          >
            <button
              type="button"
              className={
                mine
                  ? 'font-serif font-medium text-mead hover:underline focus:outline-none focus-visible:underline'
                  : 'font-serif font-medium hover:underline focus:outline-none focus-visible:underline'
              }
            >
              {message.author.displayName}
            </button>
          </MemberProfileTrigger>
          <span className="font-mono text-xs text-fg-muted">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
          {message.editedAt ? <span className="text-xs text-fg-muted">(edited)</span> : null}
        </div>
        {message.forwardedFrom ? (
          <p className="flex items-center gap-1 text-xs italic text-fg-muted">
            <Forward size={11} aria-hidden /> Forwarded from {message.forwardedFrom.authorDisplayName}
          </p>
        ) : null}
        {message.replyTo ? (
          <ReplyContext
            authorDisplayName={message.replyTo.authorDisplayName}
            contentExcerpt={message.replyTo.contentExcerpt}
            deleted={message.replyTo.deleted}
            onClickParent={() => {
              const el = document.querySelector(
                `[data-message-id="${message.replyTo?.id}"]`,
              );
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          />
        ) : null}
        {message.pollId ? <PollMessage pollId={message.pollId} /> : null}
        {!message.pollId && message.content ? <MessageContent content={message.content} /> : null}
        {message.content && /\bhttps?:\/\//.test(message.content) ? (
          <LinkPreviewCard messageId={message.id} />
        ) : null}
        {message.attachmentIds.map((id) => (
          <AttachmentView key={id} id={id} />
        ))}
        <ReactionBar message={message} />
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          onClick={onOpenThread}
          aria-label="Open thread"
          title="Open thread"
          className="rounded p-1 text-fg-muted hover:bg-raised"
        >
          <MessageSquare size={14} />
        </button>
        <button
          type="button"
          onClick={onSave}
          aria-label="Save message"
          title="Save"
          className="rounded p-1 text-fg-muted hover:bg-raised"
        >
          <Bookmark size={14} />
        </button>
        <button
          type="button"
          onClick={onForward}
          aria-label="Forward message"
          title="Forward"
          className="rounded p-1 text-fg-muted hover:bg-raised"
        >
          <Forward size={14} />
        </button>
        {message.editedAt ? (
          <button
            type="button"
            onClick={onShowHistory}
            aria-label="View edit history"
            title="Edit history"
            className="rounded p-1 text-fg-muted hover:bg-raised"
          >
            <History size={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onPin}
          aria-label="Pin message"
          title="Pin (requires MANAGE_MESSAGES)"
          className="rounded p-1 text-fg-muted hover:bg-raised"
        >
          <Pin size={14} />
        </button>
        <button
          type="button"
          onClick={onReport}
          aria-label="Report message"
          title="Report"
          className="rounded p-1 text-fg-muted hover:bg-raised"
        >
          <Flag size={14} />
        </button>
        {mine ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete message"
            title="Delete"
            className="rounded p-1 text-fg-muted hover:bg-raised"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
