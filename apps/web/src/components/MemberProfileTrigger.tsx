import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useNavigate } from '@tanstack/react-router';
import { Permission, type Member, type UserProfile } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth.js';
import { useCanIn, useRealtime } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { startDmWith } from '../lib/dm.js';
import { MemberProfileCard } from './MemberProfileCard.js';
import { EditProfileModal } from './EditProfileModal.js';
import { TimeoutModal } from './TimeoutModal.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface MemberProfileTriggerProps {
  userId: string;
  /** When the trigger lives inside a server context (sidebar, message, voice). */
  serverId: string | null;
  /** Member row already known to the caller (sidebar passes this). Optional. */
  member?: Member | null;
  /** Element that the popover anchors to — must accept Radix `asChild` spread. */
  children: ReactNode;
  side?: 'left' | 'right' | 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

/**
 * Wraps any clickable element to surface the Discord-style member profile
 * card on click. Lazily fetches the rich profile on first open and caches
 * it; subsequent opens are instant. Uses Radix Popover for positioning,
 * outside-click dismissal, and keyboard handling.
 */
export function MemberProfileTrigger({
  userId,
  serverId,
  member: memberProp,
  children,
  side = 'left',
  align = 'start',
}: MemberProfileTriggerProps): JSX.Element {
  const me = useAuth((s) => s.me);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const loaded = useRealtime((s) => s.profilesByUserId[userId]);
  const rolesEntry = useRealtime((s) => (serverId ? s.rolesByServerId[serverId] : undefined));
  const presence = useRealtime(
    (s) => s.presenceByUserId[userId] ?? memberProp?.user.presence ?? 'offline',
  );
  const activeChannelId = useRealtime((s) => s.activeChannelId);
  const loadProfile = useRealtime((s) => s.loadProfile);
  const loadRolesForServer = useRealtime((s) => s.loadRolesForServer);
  const loadMyServerPermissions = useRealtime((s) => s.loadMyServerPermissions);
  const setProfile = useRealtime((s) => s.setProfile);
  const queueMention = useRealtime((s) => s.queueMention);
  const canManageNicknames = useCanIn(serverId, Permission.MANAGE_NICKNAMES);

  const isSelf = me?.id === userId;
  const roles = useMemo(() => rolesEntry?.roles ?? [], [rolesEntry]);
  // Self-nickname edit happens through "Edit profile"; the inline editor
  // is for moderating other members. Gate on MANAGE_NICKNAMES via the
  // viewer permissions slice (server owners get ADMINISTRATOR which
  // bypasses the explicit bit check inside useCanIn).
  const canSetNickname = !isSelf && Boolean(serverId) && canManageNicknames;
  const canMention = !isSelf && activeChannelId != null;
  const canTimeoutMember = useCanIn(serverId, Permission.TIMEOUT_MEMBERS);
  const canKickMember = useCanIn(serverId, Permission.KICK_MEMBERS);
  const canTimeout = !isSelf && Boolean(serverId) && canTimeoutMember;
  const canKick = !isSelf && Boolean(serverId) && canKickMember;
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const [kickOpen, setKickOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadProfile(userId);
    if (serverId) {
      void loadRolesForServer(serverId);
      void loadMyServerPermissions(serverId);
    }
  }, [open, userId, serverId, loadProfile, loadRolesForServer, loadMyServerPermissions]);

  const handleSend = useCallback(() => {
    setOpen(false);
    void startDmWith(userId, navigate);
  }, [userId, navigate]);

  const handleMention = useCallback(() => {
    if (!activeChannelId) {
      toast.error('Open a room to mention this member.');
      return;
    }
    const display =
      loaded?.state === 'loaded' ? loaded.profile.displayName : memberProp?.user.displayName;
    if (!display) return;
    queueMention(activeChannelId, display);
    setOpen(false);
  }, [activeChannelId, loaded, memberProp, queueMention]);

  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
    } catch {
      toast.error('Clipboard is blocked in this browser.');
    }
  }, [userId]);

  const handleSaveNickname = useCallback(
    async (next: string | null) => {
      if (!serverId) return;
      try {
        await api(`/servers/${serverId}/members/${userId}`, {
          method: 'PATCH',
          body: { nickname: next },
        });
        toast.success('Nickname saved.');
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not save nickname.');
      }
    },
    [serverId, userId],
  );

  const handleRetry = useCallback(() => {
    void loadProfile(userId, { force: true });
  }, [userId, loadProfile]);

  const handleEditSaved = useCallback(
    (profile: UserProfile) => {
      setProfile(profile.id, profile);
      setEditOpen(false);
    },
    [setProfile],
  );

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>{children}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={12}
            className="z-50 overflow-hidden rounded-md border border-subtle bg-surface shadow-lg transition-base"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <MemberProfileCard
              userId={userId}
              serverId={serverId}
              loaded={loaded}
              member={memberProp ?? null}
              roles={roles}
              presence={presence}
              isSelf={isSelf}
              canSetNickname={canSetNickname}
              canMention={canMention}
              canTimeout={canTimeout}
              canKick={canKick}
              onSendMessage={handleSend}
              onMention={handleMention}
              onTimeout={() => {
                setOpen(false);
                setTimeoutOpen(true);
              }}
              onKick={() => {
                setOpen(false);
                setKickOpen(true);
              }}
              onCopyId={handleCopyId}
              onSaveNickname={handleSaveNickname}
              onEditProfile={() => {
                setOpen(false);
                setEditOpen(true);
              }}
              onClose={() => setOpen(false)}
              onRetry={handleRetry}
            />
            <Popover.Arrow className="fill-surface" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {editOpen ? (
        <EditProfileModal
          open={editOpen}
          onOpenChange={setEditOpen}
          onSaved={handleEditSaved}
        />
      ) : null}
      {timeoutOpen && serverId ? (
        <TimeoutModal
          serverId={serverId}
          userId={userId}
          displayName={loaded?.state === 'loaded' ? loaded.profile.displayName : userId}
          onClose={() => setTimeoutOpen(false)}
        />
      ) : null}
      {kickOpen && serverId ? (
        <ConfirmDialog
          title="Kick this member?"
          description="They’ll lose access immediately but can re-join via an invite."
          confirmLabel="Kick"
          destructive
          onCancel={() => setKickOpen(false)}
          onConfirm={async () => {
            setKickOpen(false);
            try {
              await api(`/servers/${serverId}/members/${userId}/kick`, {
                method: 'POST',
                body: {},
              });
              toast.info('Kicked.');
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not kick');
            }
          }}
        />
      ) : null}
    </>
  );
}
