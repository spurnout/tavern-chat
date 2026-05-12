import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import {
  Dice5,
  Hash,
  LogOut,
  Menu,
  Monitor,
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
import { startRealtime, stopRealtime } from '../lib/realtime.js';
import { api } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import type { Channel, Server } from '@tavern/shared';
import { cn } from '../lib/cn.js';
import { CreateServerModal } from '../components/CreateServerModal.js';
import { CreateChannelModal } from '../components/CreateChannelModal.js';

export function AppShell(): JSX.Element {
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  const servers = useRealtime((s) => Object.values(s.serversById));
  const channelsByServer = useRealtime((s) => s.channelsByServer);
  const upsertServer = useRealtime((s) => s.upsertServer);
  const upsertChannels = useRealtime((s) => s.upsertChannels);

  const params = useParams({ strict: false }) as {
    serverId?: string;
    channelId?: string;
  };

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);

  // FE-03: ref-guarded one-shot auto-navigate. The original effect had a
  // blank deps array and captured the mount-time value of params.serverId; if
  // a later navigation happened before /servers resolved, we'd land on a
  // stale tavern. Using a ref means we only auto-redirect once per mount,
  // and only if the user hasn't already navigated themselves.
  const autoNavigatedRef = useRef(false);
  useEffect(() => {
    startRealtime();
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

  const activeServer = params.serverId ? servers.find((s) => s.id === params.serverId) : null;
  const channels = params.serverId ? (channelsByServer[params.serverId] ?? []) : [];

  return (
    <div className="relative flex h-full bg-canvas text-fg">
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
        <Outlet />
      </main>

      <CreateServerModal open={createServerOpen} onOpenChange={setCreateServerOpen} />
      {params.serverId ? (
        <CreateChannelModal
          serverId={params.serverId}
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
        />
      ) : null}
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
              'grid h-12 w-12 place-items-center rounded-2xl font-serif text-lg font-bold transition-base',
              active
                ? 'bg-ember text-fg-on-accent rounded-xl'
                : 'bg-raised text-fg hover:rounded-xl hover:bg-ember-hi hover:text-fg-on-accent',
            )}
          >
            {s.name.slice(0, 2).toUpperCase()}
          </Link>
        );
      })}
      <div className="my-1 h-px w-8 bg-raised" />
      <button
        aria-label="Add den"
        onClick={onCreateServer}
        className="grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-subtle text-fg-muted hover:bg-raised hover:rounded-xl"
        title="Create a new den"
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
  me: { displayName: string; username: string } | null;
  onLogout: () => void;
  onCreateChannel: () => void;
}

function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  activeServerId,
  me,
  onLogout,
  onCreateChannel,
}: ChannelSidebarProps): JSX.Element {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-subtle bg-sunken">
      <div className="flex items-center justify-between gap-2 border-b border-subtle p-3">
        <div className="min-w-0">
          <div className="truncate font-serif font-medium">{server?.name ?? '…'}</div>
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
          <SidebarSection title="Den">
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
        <button aria-label="Settings" className="rounded p-1 hover:bg-raised" title="Settings">
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
    'flex items-center gap-2 rounded px-2 py-1.5 text-fg',
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
