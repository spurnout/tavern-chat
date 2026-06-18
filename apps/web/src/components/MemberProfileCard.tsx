import { useState } from 'react';
import { Check, Copy, ExternalLink, MessageSquare, Pencil, AtSign, X } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import type { Member, Role, UserProfile } from '@tavern/shared';
import type { Presence } from '@tavern/shared';
import { useRealtime, type LoadedProfile } from '../lib/store.js';
import { useBlocks, useIsBlocked } from '../lib/blocks-store.js';
import { toast } from '../lib/toast.js';
import { cn } from '../lib/cn.js';
import { PresenceDot } from './PresenceDot.js';

const PRESENCE_LABEL: Record<Presence, string> = {
  active: 'Active',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

function hexFromRoleColor(color: number): string {
  // Roles store color as a 24-bit integer rendered as a hex string. The
  // "no colour" case (0) is handled by the caller with neutral semantic
  // tokens, so it never reaches here.
  return `#${color.toString(16).padStart(6, '0')}`;
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';
  return trimmed.slice(0, 2).toUpperCase();
}

function formatJoinedDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * True if `expiresAt` is in the past. The worker sweep clears expired
 * custom statuses every 5 minutes; this gate hides the row during the
 * gap between expiry and the next sweep. Accepts the profile snapshot's
 * ISO string OR the live-overlay's `Date` — both shapes route through here.
 */
function isExpired(expiresAt: string | Date | null): boolean {
  if (!expiresAt) return false;
  const t =
    typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  return Number.isFinite(t) && t < Date.now();
}

// Defense-in-depth: the schema now restricts profile-link URLs to safe
// schemes, but legacy rows or a future schema regression shouldn't render
// `javascript:` / `data:` / etc. into an `href`.
const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
function isSafeHref(url: string): boolean {
  try {
    return SAFE_HREF_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

interface MemberProfileCardProps {
  userId: string;
  serverId: string | null;
  loaded: LoadedProfile | undefined;
  member: Member | null;
  roles: Role[];
  presence: Presence;
  isSelf: boolean;
  canSetNickname: boolean;
  canMention: boolean;
  /** Wave 2 — moderation actions. */
  canTimeout: boolean;
  canKick: boolean;
  onSendMessage: () => void;
  onMention: () => void;
  onTimeout: () => void;
  onKick: () => void;
  onCopyId: () => Promise<void> | void;
  onSaveNickname: (next: string | null) => Promise<void> | void;
  onEditProfile: () => void;
  onClose: () => void;
  onRetry: () => void;
}

/**
 * The Discord-style profile card rendered inside a Popover.Content. Pure
 * presentational — all data and callbacks come from props (the trigger
 * wraps it). Width clamps so it stays usable on mobile.
 */
export function MemberProfileCard({
  userId,
  serverId,
  loaded,
  member,
  roles,
  presence,
  isSelf,
  canSetNickname,
  canMention,
  canTimeout,
  canKick,
  onSendMessage,
  onMention,
  onTimeout,
  onKick,
  onCopyId,
  onSaveNickname,
  onEditProfile,
  onClose,
  onRetry,
}: MemberProfileCardProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [editingNick, setEditingNick] = useState(false);
  const [nickDraft, setNickDraft] = useState(member?.nickname ?? '');
  const [nickSaving, setNickSaving] = useState(false);

  const state = loaded?.state ?? 'loading';
  const profile: UserProfile | null = loaded?.state === 'loaded' ? loaded.profile : null;
  const displayName = profile?.displayName ?? member?.user.displayName ?? '…';
  const username = profile?.username ?? member?.user.username ?? '';
  const nickname = member?.nickname ?? null;
  const accent = profile?.accentColor ?? null;

  // PF-2 / follow-up #32 — live-first resolution. When a PRESENCE_UPDATE
  // broadcast has carried the user's customStatus we use that; otherwise we
  // fall through to the snapshot baked into the profile fetch. Critically,
  // an explicit `null` from the live source means the user CLEARED their
  // status, so we render NO pill (we do NOT fall through to the profile
  // snapshot — that would resurrect the stale string until the next
  // profile re-fetch).
  const liveCustomStatus = useRealtime((s) => s.customStatusByUserId[userId]);
  const hasLiveCustomStatus = liveCustomStatus !== undefined;
  const effectiveCustomStatus = hasLiveCustomStatus
    ? liveCustomStatus.status
    : profile?.customStatus ?? null;
  const effectiveCustomStatusExpiresAt: string | Date | null = hasLiveCustomStatus
    ? liveCustomStatus.expiresAt
    : profile?.customStatusExpiresAt ?? null;
  const showCustomStatus =
    effectiveCustomStatus !== null &&
    !isExpired(effectiveCustomStatusExpiresAt);

  const handleCopyId = async (): Promise<void> => {
    await onCopyId();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleSaveNick = async (): Promise<void> => {
    setNickSaving(true);
    try {
      const trimmed = nickDraft.trim();
      await onSaveNickname(trimmed.length === 0 ? null : trimmed);
      setEditingNick(false);
    } finally {
      setNickSaving(false);
    }
  };

  const isBlocked = useIsBlocked(userId);
  const [blockBusy, setBlockBusy] = useState(false);
  const handleToggleBlock = async (): Promise<void> => {
    setBlockBusy(true);
    try {
      if (isBlocked) {
        await useBlocks.getState().unblock(userId);
        toast.success(`Unblocked ${displayName}`);
      } else {
        await useBlocks.getState().block(userId);
        toast.success(`Blocked ${displayName}`);
      }
    } catch {
      toast.error('Couldn’t update block. Try again.');
    } finally {
      setBlockBusy(false);
    }
  };

  const sortedRoles = [...roles]
    .filter((r) => !r.isEveryone && member?.roles.includes(r.id))
    .sort((a, b) => b.position - a.position);

  return (
    <div className="flex w-[min(92vw,360px)] max-h-[80vh] flex-col overflow-hidden">
      {/* Accent stripe — uses the user's chosen color, or ember as a fallback. */}
      <div
        className={cn('h-8 w-full', !accent && 'bg-ember')}
        style={accent ? { backgroundColor: accent } : undefined}
        aria-hidden="true"
      />

      <div className="-mt-6 px-5 pb-4">
        <div className="flex items-end gap-3">
          <div className="relative shrink-0">
            <div className="grid h-16 w-16 place-items-center rounded-full border-4 border-surface bg-raised font-serif text-xl font-semibold text-fg">
              {initials(displayName)}
            </div>
            <PresenceDot
              presence={presence}
              size={3.5}
              className="absolute -bottom-0.5 -right-0.5"
            />
          </div>
          <Popover.Close
            className="ml-auto self-start rounded p-1 text-fg-muted hover:bg-raised"
            aria-label="Close profile"
            onClick={onClose}
          >
            <X size={16} />
          </Popover.Close>
        </div>

        <div className="mt-3 min-w-0">
          <div className="truncate font-serif text-lg font-medium text-fg">
            {nickname ?? displayName}
          </div>
          <div className="truncate text-sm text-fg-muted">
            {nickname ? `${displayName} · @${username}` : `@${username}`}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
            <PresenceDot presence={presence} size={2} />
            <span>{PRESENCE_LABEL[presence]}</span>
            {profile?.timezone ? <span aria-hidden>·</span> : null}
            {profile?.timezone ? <span>{profile.timezone}</span> : null}
            {profile?.pronouns ? <span aria-hidden>·</span> : null}
            {profile?.pronouns ? <span>{profile.pronouns}</span> : null}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto border-t border-subtle px-5 py-3">
        {state === 'loading' ? (
          <p className="text-sm text-fg-muted">Looking them up…</p>
        ) : null}

        {state === 'error' ? (
          <div className="space-y-2">
            <p className="text-sm text-danger">Couldn&apos;t load this profile.</p>
            <button type="button" className="btn-ghost text-sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}

        {state === 'unavailable' ? (
          <p className="text-sm text-fg-muted">
            This member isn&apos;t reachable from where you&apos;re sitting.
          </p>
        ) : null}

        {profile && state === 'loaded' ? (
          <div className="space-y-3">
            {showCustomStatus ? (
              <p className="text-sm italic text-fg-muted">{effectiveCustomStatus}</p>
            ) : null}

            {profile.bio ? (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-muted">About</h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">
                  {profile.bio}
                </p>
              </section>
            ) : null}

            {sortedRoles.length > 0 ? (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-muted">Roles</h3>
                <div className="mt-1 flex flex-wrap gap-1">
                  {sortedRoles.map((role) => {
                    // No-colour roles (0) render in neutral semantic tokens
                    // rather than an off-system grey; coloured roles keep
                    // their DB-driven hex (inline by necessity).
                    if (role.color === 0) {
                      return (
                        <span
                          key={role.id}
                          className="rounded-full border border-subtle bg-tint-fg-04 px-2 py-0.5 text-xs text-fg-muted"
                        >
                          {role.name}
                        </span>
                      );
                    }
                    const hex = hexFromRoleColor(role.color);
                    return (
                      <span
                        key={role.id}
                        className="rounded-full border px-2 py-0.5 text-xs"
                        style={{
                          borderColor: hex,
                          color: hex,
                          backgroundColor: `${hex}1a`,
                        }}
                      >
                        {role.name}
                      </span>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {profile.socialLinks.filter((l) => isSafeHref(l.url)).length > 0 ? (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-muted">Elsewhere</h3>
                <ul className="mt-1 space-y-1">
                  {profile.socialLinks
                    .filter((link) => isSafeHref(link.url))
                    .map((link) => (
                      <li key={`${link.label}-${link.url}`}>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-ember hover:underline"
                        >
                          {link.label}
                          <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h3 className="text-xs uppercase tracking-wider text-fg-muted">
                {serverId && member ? 'Member since' : 'Joined Tavern'}
              </h3>
              <p className="mt-1 text-sm text-fg">
                {formatJoinedDate(member?.joinedAt ?? profile.createdAt)}
              </p>
            </section>

            {!isSelf && profile.mutualServers.length > 0 ? (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-muted">
                  Also in {profile.mutualServers.length} of your taverns
                </h3>
                <ul className="mt-1 space-y-1">
                  {profile.mutualServers.slice(0, 5).map((tavern) => (
                    <li key={tavern.id} className="flex items-center gap-2 text-sm">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-raised font-serif text-[10px] font-semibold">
                        {tavern.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="truncate text-fg">{tavern.name}</span>
                    </li>
                  ))}
                  {profile.mutualServers.length > 5 ? (
                    <li className="text-xs text-fg-muted">
                      and {profile.mutualServers.length - 5} more
                    </li>
                  ) : null}
                </ul>
              </section>
            ) : null}

            {canSetNickname && serverId ? (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-muted">Nickname</h3>
                {editingNick ? (
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      className="input flex-1"
                      type="text"
                      value={nickDraft}
                      placeholder={displayName}
                      maxLength={32}
                      onChange={(e) => setNickDraft(e.target.value)}
                      disabled={nickSaving}
                    />
                    <button
                      type="button"
                      className="btn-primary text-xs"
                      onClick={() => void handleSaveNick()}
                      disabled={nickSaving}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => {
                        setEditingNick(false);
                        setNickDraft(nickname ?? '');
                      }}
                      disabled={nickSaving}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-sm text-fg">
                      {nickname ?? <span className="text-fg-muted">No nickname set</span>}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => {
                        setNickDraft(nickname ?? '');
                        setEditingNick(true);
                      }}
                    >
                      <Pencil size={12} className="mr-1 inline-block" />
                      Edit
                    </button>
                  </div>
                )}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="border-t border-subtle bg-sunken px-5 py-3">
        <div className="flex flex-wrap gap-2">
          {isSelf ? (
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={onEditProfile}
            >
              <Pencil size={14} className="mr-1.5 inline-block" />
              Edit profile
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={onSendMessage}
              disabled={state !== 'loaded'}
            >
              <MessageSquare size={14} className="mr-1.5 inline-block" />
              Send a message
            </button>
          )}
          {!isSelf && canMention ? (
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={onMention}
              disabled={state !== 'loaded'}
            >
              <AtSign size={14} className="mr-1.5 inline-block" />
              Mention in this room
            </button>
          ) : null}
          {!isSelf && canTimeout ? (
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={onTimeout}
            >
              Time out…
            </button>
          ) : null}
          {!isSelf && canKick ? (
            <button
              type="button"
              className="btn-ghost text-sm text-danger"
              onClick={onKick}
            >
              Kick from tavern…
            </button>
          ) : null}
          {!isSelf ? (
            <button
              type="button"
              className={cn('btn-ghost text-sm', !isBlocked && 'text-danger')}
              onClick={() => void handleToggleBlock()}
              disabled={blockBusy}
            >
              {isBlocked ? 'Unblock member' : 'Block member'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => void handleCopyId()}
            aria-live="polite"
            title={`Copy user ID ${userId}`}
          >
            {copied ? (
              <>
                <Check size={14} className="mr-1.5 inline-block" />
                Copied
              </>
            ) : (
              <>
                <Copy size={14} className="mr-1.5 inline-block" />
                Copy ID
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
