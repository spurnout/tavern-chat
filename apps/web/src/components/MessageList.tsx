import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Bookmark,
  ChevronRight,
  Dice5,
  Flag,
  Forward,
  History,
  MessageSquare,
  Pin,
  Trash2,
} from 'lucide-react';
import type { DiceTermResult, Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { useInbox } from '../lib/inbox-store.js';
import { useIsBlocked } from '../lib/blocks-store.js';
import { useAuth } from '../lib/auth.js';
import { useRememberedMessageScroll } from '../lib/message-scroll-memory.js';
import { ThreadPanel } from './ThreadPanel.js';
import { PollMessage } from './PollMessage.js';
import { MessageContent } from './MessageContent.js';
import { MessageEmbeds } from './MessageEmbeds.js';
import { MessageComponents } from './MessageComponents.js';
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
  const totalSize = virtualizer.getTotalSize();
  useRememberedMessageScroll(parentRef, {
    storageKey: `channel:${channelId}`,
    itemCount: sorted.length,
    totalSize,
  });

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
      <div style={{ height: totalSize, position: 'relative' }}>
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
  // Block collapse: a blocked author's messages are hidden behind a reveal.
  // The server still delivers them (fan-out stays symmetric so the blocked
  // member is unaware) — this is purely the blocker's client choosing not to
  // show them. `mine` messages are never blocked (you can't block yourself).
  const blocked = useIsBlocked(message.authorId);
  const [revealed, setRevealed] = useState(false);

  if (message.deletedAt) {
    return (
      <div className="rounded px-3 py-2 text-sm italic text-fg-muted">message deleted</div>
    );
  }
  if (message.type === 'dice_roll') {
    return <DiceRollMessage message={message} />;
  }
  if (message.type === 'system') {
    return (
      <div className="px-3 py-1 text-sm italic text-fg-muted">{message.content}</div>
    );
  }
  if (blocked && !revealed) {
    return (
      <div className="flex items-center gap-2 rounded px-3 py-1.5 text-sm italic text-fg-muted">
        <span>Blocked message</span>
        <button
          type="button"
          className="not-italic text-ember hover:underline"
          onClick={() => setRevealed(true)}
        >
          Reveal
        </button>
      </div>
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
        {message.embeds && message.embeds.length > 0 ? (
          <MessageEmbeds embeds={message.embeds} />
        ) : null}
        {message.components && message.components.length > 0 ? (
          <MessageComponents messageId={message.id} rows={message.components} />
        ) : null}
        {message.content && /\bhttps?:\/\//.test(message.content) ? (
          <LinkPreviewCard messageId={message.id} />
        ) : null}
        {message.attachmentIds.map((id) => (
          <AttachmentView key={id} id={id} />
        ))}
        <ThreadFooter
          summary={message.threadSummary ?? null}
          isThreadRoot={message.isThreadRoot ?? false}
          onOpen={onOpenThread}
        />
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

/**
 * Render a `dice_roll` message. When the API includes the inline `diceRoll`
 * payload we show the per-die breakdown plus the total; on older messages
 * (saved before the inline field landed, or surfaces that don't include it
 * yet) we gracefully fall back to the raw notation in `content`.
 */
export function DiceRollMessage({ message }: { message: Message }): JSX.Element {
  const roll = message.diceRoll;
  return (
    <div className="rounded-md border border-subtle bg-surface px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-mead">
        <Dice5 size={16} />
        {roll ? (
          <>
            {roll.label ? <span className="font-medium">{roll.label}:</span> : null}
            <span className="font-mono">{roll.notation}</span>
            <span className="text-fg-muted">→</span>
            <span className="font-mono text-fg">
              <DiceTerms terms={roll.terms} />
            </span>
            <span className="text-fg-muted">=</span>
            <span className="font-mono text-base font-semibold text-fg">{roll.total}</span>
          </>
        ) : (
          <span className="font-mono">{message.content}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Clickable footer rendered below a thread-root message. Shows the reply
 * count and last activity if we have a summary; falls back to a plain
 * "View thread" affordance when the root has been promoted but no replies
 * have landed yet (or for older messages the API hasn't backfilled).
 *
 * Always-visible (not hover-gated) so a started thread feels permanent and
 * discoverable.
 */
function ThreadFooter({
  summary,
  isThreadRoot,
  onOpen,
}: {
  summary: Message['threadSummary'];
  isThreadRoot: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  if (!isThreadRoot && !summary) return null;
  const count = summary?.replyCount ?? 0;
  const countLabel = count === 0 ? 'View thread' : `${count} ${count === 1 ? 'reply' : 'replies'}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={count > 0 ? `Open thread with ${count} ${count === 1 ? 'reply' : 'replies'}` : 'Open thread'}
      className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-subtle bg-tint-ember px-2 py-1 text-xs text-ember transition-base hover:border-ember focus:outline-none focus-visible:ring-1 focus-visible:ring-ember"
    >
      <MessageSquare size={12} className="shrink-0" aria-hidden />
      <span className="font-medium">{countLabel}</span>
      {summary && count > 0 ? (
        <>
          <span className="text-fg-muted">·</span>
          <span className="text-fg-muted">Last reply {threadTimeAgo(summary.lastActivityAt)}</span>
        </>
      ) : null}
      <ChevronRight size={12} className="ml-0.5 shrink-0 text-fg-muted" aria-hidden />
    </button>
  );
}

function threadTimeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 60 * 60_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.round(diffMs / (60 * 60_000))}h ago`;
  return `${Math.round(diffMs / (24 * 60 * 60_000))}d ago`;
}

function DiceTerms({ terms }: { terms: DiceTermResult[] }): JSX.Element {
  return (
    <>
      {terms.map((term, i) => (
        <span key={i}>
          {i > 0 ? <span className="px-1 text-fg-muted">{term.sign === -1 ? '−' : '+'}</span> : null}
          {term.kind === 'dice' ? (
            <span>
              [
              {term.rolls.map((die, j) => (
                <span key={j}>
                  {j > 0 ? ', ' : ''}
                  <span
                    className={die.kept ? '' : 'text-fg-muted line-through decoration-fg-muted'}
                  >
                    {die.value}
                  </span>
                </span>
              ))}
              ]
            </span>
          ) : (
            <span>{Math.abs(term.value)}</span>
          )}
        </span>
      ))}
    </>
  );
}
