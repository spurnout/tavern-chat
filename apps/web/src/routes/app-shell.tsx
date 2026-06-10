import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import {
  Dice5,
  Hash,
  LogOut,
  User as UserIcon,
  MessageCircle,
  Menu,
  Monitor,
  Network,
  Plus,
  Search,
  Settings,
  Shield,
  Swords,
  Volume2,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth.js';
import { useAnyScreenSharing, useRealtime } from '../lib/store.js';
import { useNotificationSettings } from '../lib/notification-settings.js';
import { startRealtime, stopRealtime } from '../lib/realtime.js';
import { api } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import type { Channel, Server } from '@tavern/shared';
import { cn } from '../lib/cn.js';
import { CreateServerModal } from '../components/CreateServerModal.js';
import { CreateChannelModal } from '../components/CreateChannelModal.js';
import { NotificationSettingsModal } from '../components/NotificationSettingsModal.js';
import { UserStatusPopover } from '../components/UserStatusPopover.js';
import { InboxPanel } from '../components/InboxPanel.js';
import { SavedPanel } from '../components/SavedPanel.js';
import { ImageLightbox } from '../components/ImageLightbox.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { WelcomeScreen } from '../components/onboarding/WelcomeScreen.js';
import { onUi } from '../lib/ui-events.js';

// Stable empty-array fallback; never mutated. Module-level so the same
// reference survives every render and React.memo'd consumers see prop
// equality. Cast away ReadonlyArray so consumers still get Channel[].
const EMPTY_CHANNELS = [] as Channel[];

const VoiceRoom = lazy(() =>
  import('../components/VoiceRoom.js').then((module) => ({ default: module.VoiceRoom })),
);

export function AppShell(): JSX.Element {
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  // Selector returns the dict directly; the Object.values derivation runs
  // AFTER subscription so React's useSyncExternalStore compares the same
  // dict reference between renders. The previous code inlined Object.values
  // into the selector, returning a fresh array on every getSnapshot call,
  // which made React think the store had changed every render and looped.
  const serversById = useRealtime((s) => s.serversById);
  const servers = useMemo(() => Object.values(serversById), [serversById]);
  const channelsByServer = useRealtime((s) => s.channelsByServer);
  const upsertServer = useRealtime((s) => s.upsertServer);
  const upsertChannels = useRealtime((s) => s.upsertChannels);
  const setActiveChannelId = useRealtime((s) => s.setActiveChannelId);

  const params = useParams({ strict: false }) as {
    serverId?: string;
    channelId?: string;
  };

  // Persistent voice: the LiveKit session lives on the AppShell so it
  // survives navigation to other channels. The voice route just records
  // the user's intent in `currentVoice`; the actual <VoiceRoom> is mounted
  // below and stays alive until the user hits hangup.
  const currentVoice = useRealtime((s) => s.currentVoice);
  const setCurrentVoice = useRealtime((s) => s.setCurrentVoice);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnVoiceRoute =
    !!currentVoice && pathname === `/app/servers/${currentVoice.serverId}/voice/${currentVoice.channelId}`;

  const handleVoiceLeave = useCallback((): void => {
    const voice = useRealtime.getState().currentVoice;
    setCurrentVoice(null);
    // If they hit hangup from the expanded view, send them back to the
    // server home. From the minimized bar on another channel, stay put.
    if (voice && pathname === `/app/servers/${voice.serverId}/voice/${voice.channelId}`) {
      void navigate({ to: '/app/servers/$serverId', params: { serverId: voice.serverId } });
    }
  }, [setCurrentVoice, navigate, pathname]);

  const handleVoiceExpand = useCallback((): void => {
    if (!currentVoice) return;
    void navigate({
      to: '/app/servers/$serverId/voice/$channelId',
      params: { serverId: currentVoice.serverId, channelId: currentVoice.channelId },
    });
  }, [navigate, currentVoice]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);

  // Palette → shell signals: the command palette dispatches typed UI events
  // (e.g. "open the create-server modal") so distant call sites don't need to
  // thread callbacks down through the tree.
  useEffect(() => {
    return onUi((e) => {
      if (e.kind === 'open-create-server') setCreateServerOpen(true);
      else if (e.kind === 'open-create-channel') {
        if (params.serverId) setCreateChannelOpen(true);
        else toast.info('Pick a tavern first, then open a new room.');
      } else if (e.kind === 'open-notification-settings') {
        setNotificationSettingsOpen(true);
      }
    });
  }, [params.serverId]);

  // FE-03: ref-guarded one-shot auto-navigate. The original effect had a
  // blank deps array and captured the mount-time value of params.serverId; if
  // a later navigation happened before /servers resolved, we'd land on a
  // stale tavern. Using a ref means we only auto-redirect once per mount,
  // and only if the user hasn't already navigated themselves.
  const autoNavigatedRef = useRef(false);
  useEffect(() => {
    startRealtime();
    // Fetch the user's global notification preferences once on shell mount.
    // Per-tavern prefs load lazily when the relevant settings tab opens.
    void useNotificationSettings.getState().loadGlobal();
    // Wave 3 #5 — pull cross-device composer drafts. Cheap; never blocks UI.
    void useRealtime.getState().loadDrafts();
    api<Server[]>('/servers')
      .then((list) => {
        for (const s of list) upsertServer(s);
        if (!autoNavigatedRef.current && !params.serverId && list[0]) {
          autoNavigatedRef.current = true;
          void navigate({
            to: '/app/servers/$serverId',
            params: { serverId: list[0].id },
          });
        }
      })
      .catch(() => {
        toast.error('Could not load your taverns. Please reload.');
      });
    return () => stopRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!params.serverId) return;
    api<Channel[]>(`/servers/${params.serverId}/channels`)
      .then((channels) => upsertChannels(params.serverId!, channels))
      .catch(() => {
        // FE-23: surface the failure instead of leaving the sidebar blank.
        toast.error('Could not load rooms in this tavern.');
      });
  }, [params.serverId, upsertChannels]);

  // Close drawer on navigation (mobile UX)
  useEffect(() => {
    setDrawerOpen(false);
  }, [params.channelId, params.serverId]);

  // Mirror the active channel id into the store so the chat-sound gate
  // can tell "viewing this channel right now" from "in the app but
  // elsewhere." Cleared on unmount so a stale id doesn't leak.
  useEffect(() => {
    setActiveChannelId(params.channelId ?? null);
    return () => setActiveChannelId(null);
  }, [params.channelId, setActiveChannelId]);

  const activeServer = params.serverId ? servers.find((s) => s.id === params.serverId) : null;
  // Stable empty fallback so the `?? []` (a fresh literal on every render)
  // doesn't hand a new array reference to ChannelSidebar each pass — would
  // defeat React.memo if we ever wrap it.
  const channels = useMemo(
    () => (params.serverId ? channelsByServer[params.serverId] ?? EMPTY_CHANNELS : EMPTY_CHANNELS),
    [params.serverId, channelsByServer],
  );

  return (
    <div className="relative flex h-full bg-canvas text-fg">
      {/* Parity gap #3 — first-run welcome screen for the active tavern. Keyed
          by serverId so it re-evaluates on tavern switch; self-hides when
          onboarding is disabled or already completed. */}
      {params.serverId ? <WelcomeScreen key={params.serverId} serverId={params.serverId} /> : null}
      {/* Skip link — first tab stop on the page, jumps over the rails to the
          message column for keyboard users. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-fg focus:outline-none focus:ring-2 focus:ring-ember"
      >
        Skip to messages
      </a>
      {/* Mobile menu toggle */}
      <button
        type="button"
        aria-label="Toggle menu"
        className="absolute left-3 top-3 z-30 rounded p-1.5 bg-surface shadow md:hidden"
        onClick={() => setDrawerOpen((v) => !v)}
      >
        {drawerOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Sidebars: full on md+, drawer on mobile */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 z-20 flex transition-transform md:static md:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <ServerRail
          servers={servers}
          activeId={params.serverId}
          onCreateServer={() => setCreateServerOpen(true)}
        />
        <ChannelSidebar
          server={activeServer ?? null}
          channels={channels}
          activeChannelId={params.channelId}
          activeServerId={params.serverId ?? null}
          me={me}
          onLogout={() => void logout()}
          onCreateChannel={() => setCreateChannelOpen(true)}
          onOpenSettings={() => setNotificationSettingsOpen(true)}
        />
      </div>

      {/* Backdrop on mobile */}
      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          className="absolute inset-0 z-10 bg-black/60 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col focus:outline-none">
        {/* Route content. Hidden (but still mounted, so VoicePage's effect
            keeps firing) when the voice room is expanded over this column. */}
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            currentVoice && isOnVoiceRoute ? 'hidden' : 'flex',
          )}
        >
          <Outlet />
        </div>
        {/* Persistent voice room. Same component instance on every render —
            navigating from /voice/$id to /channels/$id flips `minimized`
            but never unmounts <VoiceRoom>, so the LiveKit Room and the
            user's camera/mic state survive across channel changes. */}
        {currentVoice ? (
          <div className={isOnVoiceRoute ? 'flex min-w-0 flex-1 flex-col' : 'shrink-0'}>
            <Suspense
              fallback={
                <div className="border-t border-subtle bg-sunken px-4 py-3 text-sm text-fg-muted">
                  Opening voice room...
                </div>
              }
            >
              <VoiceRoom
                key={currentVoice.channelId}
                channelId={currentVoice.channelId}
                channelName={currentVoice.channelName}
                serverId={currentVoice.serverId}
                minimized={!isOnVoiceRoute}
                onLeave={handleVoiceLeave}
                onExpand={handleVoiceExpand}
              />
            </Suspense>
          </div>
        ) : null}
      </main>

      <CreateServerModal open={createServerOpen} onOpenChange={setCreateServerOpen} />
      {params.serverId ? (
        <CreateChannelModal
          serverId={params.serverId}
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
        />
      ) : null}
      <NotificationSettingsModal
        open={notificationSettingsOpen}
        onOpenChange={setNotificationSettingsOpen}
      />
      <ImageLightbox />
      <CommandPalette />
    </div>
  );
}

function ServerRail({
  servers,
  activeId,
  onCreateServer,
}: {
  servers: Server[];
  activeId: string | undefined;
  onCreateServer: () => void;
}): JSX.Element {
  return (
    <aside className="flex h-full w-[72px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-subtle bg-sunken py-4">
      <Link
        to="/app/dms"
        aria-label="Direct messages"
        title="Direct messages"
        className="grid h-12 w-12 place-items-center rounded-2xl bg-raised text-fg transition-base hover:rounded-xl hover:bg-ember-hi hover:text-fg-on-accent"
      >
        <MessageCircle size={18} />
      </Link>
      <div className="my-1 h-px w-8 bg-raised" />
      {servers.map((s) => {
        const active = s.id === activeId;
        return (
          <Link
            key={s.id}
            to="/app/servers/$serverId"
            params={{ serverId: s.id }}
            aria-label={s.name}
            title={s.name}
            className={cn(
              'grid h-12 w-12 place-items-center overflow-hidden rounded-2xl font-serif text-lg font-bold transition-base',
              active
                ? 'bg-ember text-fg-on-accent rounded-xl'
                : 'bg-raised text-fg hover:rounded-xl hover:bg-ember-hi hover:text-fg-on-accent',
            )}
          >
            {s.iconUrl ? (
              <img
                src={s.iconUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              s.name.slice(0, 2).toUpperCase()
            )}
          </Link>
        );
      })}
      <div className="my-1 h-px w-8 bg-raised" />
      <button
        aria-label="Add a tavern"
        onClick={onCreateServer}
        className="grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-subtle text-fg-muted hover:bg-raised hover:rounded-xl"
        title="Create a new tavern"
      >
        <Plus size={18} />
      </button>
    </aside>
  );
}

interface ChannelSidebarProps {
  server: Server | null;
  channels: Channel[];
  activeChannelId: string | undefined;
  activeServerId: string | null;
  me: { displayName: string; username: string; isInstanceAdmin?: boolean } | null;
  onLogout: () => void;
  onCreateChannel: () => void;
  onOpenSettings: () => void;
}

function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  activeServerId,
  me,
  onLogout,
  onCreateChannel,
  onOpenSettings,
}: ChannelSidebarProps): JSX.Element {
  const isAdmin = me?.isInstanceAdmin === true;
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-subtle bg-sunken">
      <div className="flex items-center justify-between gap-2 border-b border-subtle p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-serif font-medium">{server?.name ?? '…'}</span>
            {/* P4-16 — federated den badge. Renders for mirror servers only
                (originInstanceId is non-null). Compact text + globe glyph so
                the row stays scannable next to a long den name. The host
                also appears on the den-settings federation tab. */}
            {server?.originInstanceId && server.originInstanceHost ? (
              <span
                className="shrink-0 rounded bg-tint-ember px-1.5 py-0.5 text-[10px] text-fg-muted"
                title={`Federated tavern hosted on ${server.originInstanceHost}`}
              >
                {`\u{1F310} ${server.originInstanceHost}`}
              </span>
            ) : null}
          </div>
          {server?.description ? (
            <div className="truncate text-xs text-fg-muted">{server.description}</div>
          ) : null}
        </div>
        {activeServerId ? (
          <Link
            to="/app/servers/$serverId/search"
            params={{ serverId: activeServerId }}
            aria-label="Search"
            className="rounded p-1 text-fg-muted hover:bg-raised"
            title="Search messages"
          >
            <Search size={14} />
          </Link>
        ) : null}
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2 text-sm">
        {activeServerId ? (
          <SidebarSection title="Tavern">
            <Link
              to="/app/servers/$serverId/campaigns"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-fg hover:bg-raised"
            >
              <span className="text-fg-muted">
                <Swords size={16} />
              </span>
              <span className="truncate">Campaigns</span>
            </Link>
            <Link
              to="/app/servers/$serverId/games"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-fg hover:bg-raised"
            >
              <span className="text-fg-muted">
                <Dice5 size={16} />
              </span>
              <span className="truncate">Games &amp; nights</span>
            </Link>
            <Link
              to="/app/servers/$serverId/moderation"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-fg hover:bg-raised"
            >
              <span className="text-fg-muted">
                <Shield size={16} />
              </span>
              <span className="truncate">Moderation</span>
            </Link>
            {isAdmin ? (
              <Link
                to="/app/admin/federation"
                className="flex items-center gap-2 rounded px-2 py-1.5 text-fg hover:bg-raised"
              >
                <span className="text-fg-muted">
                  <Network size={16} />
                </span>
                <span className="truncate">Federation</span>
              </Link>
            ) : null}
            <Link
              to="/app/servers/$serverId/settings"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-fg hover:bg-raised"
            >
              <span className="text-fg-muted">
                <Settings size={16} />
              </span>
              <span className="truncate">Settings</span>
            </Link>
          </SidebarSection>
        ) : null}
        <SidebarSection
          title="Text"
          action={
            activeServerId ? (
              <button
                type="button"
                onClick={onCreateChannel}
                aria-label="Create room"
                className="rounded p-0.5 text-fg-muted hover:bg-raised"
                title="Create room"
              >
                <Plus size={12} />
              </button>
            ) : null
          }
        >
          {channels
            .filter((c) => c.type === 'text')
            .map((c) => (
              <SidebarChannelLink
                key={c.id}
                channel={c}
                icon={<Hash size={16} />}
                active={c.id === activeChannelId}
              />
            ))}
        </SidebarSection>
        <SidebarSection title="Voice">
          {channels
            .filter((c) => c.type === 'voice')
            .map((c) => (
              <SidebarChannelLink
                key={c.id}
                channel={c}
                icon={<Volume2 size={16} />}
                active={c.id === activeChannelId}
              />
            ))}
        </SidebarSection>
      </nav>
      <footer className="flex items-center justify-between gap-2 border-t border-subtle p-2 text-sm">
        <div className="min-w-0">
          <div className="truncate font-serif font-medium">{me?.displayName ?? '—'}</div>
          <div className="truncate font-mono text-xs text-fg-muted">@{me?.username}</div>
        </div>
        <UserStatusPopover />
        <InboxPanel />
        <SavedPanel />
        <Link
          to="/app/account"
          aria-label="Account settings"
          className="rounded p-1 hover:bg-raised"
          title="Account settings"
        >
          <UserIcon size={16} />
        </Link>
        <button
          aria-label="Notification settings"
          onClick={onOpenSettings}
          className="rounded p-1 hover:bg-raised"
          title="Notification settings"
        >
          <Settings size={16} />
        </button>
        <button
          aria-label="Sign out"
          onClick={onLogout}
          className="rounded p-1 hover:bg-raised"
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
      </footer>
    </aside>
  );
}

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1 pt-3 text-xs uppercase tracking-wider text-fg-muted">
        <span>{title}</span>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SidebarChannelLink({
  channel,
  icon,
  active,
}: {
  channel: Channel;
  icon: React.ReactNode;
  active: boolean;
}): JSX.Element {
  const className = cn(
    'touch-target flex items-center gap-2 rounded px-2 py-1.5 text-fg',
    active ? 'bg-raised' : 'hover:bg-raised',
  );
  const isVoice = channel.type === 'voice';
  const someoneSharing = useAnyScreenSharing(isVoice ? channel.id : null);
  if (isVoice) {
    return (
      <Link
        to="/app/servers/$serverId/voice/$channelId"
        params={{ serverId: channel.serverId, channelId: channel.id }}
        className={className}
      >
        <span className="text-fg-muted">{icon}</span>
        <span className="truncate flex-1">{channel.name}</span>
        {someoneSharing ? (
          <>
            <Monitor size={12} className="text-ember shrink-0" aria-hidden />
            <span className="sr-only">(screen share active)</span>
          </>
        ) : null}
      </Link>
    );
  }
  return (
    <Link
      to="/app/servers/$serverId/channels/$channelId"
      params={{ serverId: channel.serverId, channelId: channel.id }}
      className={className}
    >
      <span className="text-fg-muted">{icon}</span>
      <span className="truncate">{channel.name}</span>
    </Link>
  );
}
