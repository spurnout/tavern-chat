import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import {
  Dice5,
  Hash,
  LogOut,
  Menu,
  Plus,
  Settings,
  Shield,
  Swords,
  Volume2,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth.js';
import { useRealtime } from '../lib/store.js';
import { startRealtime, stopRealtime } from '../lib/realtime.js';
import { api } from '../lib/api-client.js';
import type { Channel, Server } from '@tavern/shared';
import { cn } from '../lib/cn.js';

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

  useEffect(() => {
    startRealtime();
    api<Server[]>('/servers')
      .then((list) => {
        for (const s of list) upsertServer(s);
        if (!params.serverId && list[0]) {
          void navigate({
            to: '/app/servers/$serverId',
            params: { serverId: list[0].id },
          });
        }
      })
      .catch(() => undefined);
    return () => stopRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!params.serverId) return;
    api<Channel[]>(`/servers/${params.serverId}/channels`)
      .then((channels) => upsertChannels(params.serverId!, channels))
      .catch(() => undefined);
  }, [params.serverId, upsertChannels]);

  // Close drawer on navigation (mobile UX)
  useEffect(() => {
    setDrawerOpen(false);
  }, [params.channelId, params.serverId]);

  const activeServer = params.serverId ? servers.find((s) => s.id === params.serverId) : null;
  const channels = params.serverId ? (channelsByServer[params.serverId] ?? []) : [];

  return (
    <div className="relative flex h-full bg-tavern-ink text-tavern-parchment">
      {/* Mobile menu toggle */}
      <button
        type="button"
        aria-label="Toggle menu"
        className="absolute left-3 top-3 z-30 rounded p-1.5 bg-tavern-stone shadow md:hidden"
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
        />
        <ChannelSidebar
          server={activeServer ?? null}
          channels={channels}
          activeChannelId={params.channelId}
          activeServerId={params.serverId ?? null}
          me={me}
          onLogout={() => void logout()}
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

      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

function ServerRail({
  servers,
  activeId,
}: {
  servers: Server[];
  activeId: string | undefined;
}): JSX.Element {
  return (
    <aside className="flex h-full w-[72px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-tavern-oak bg-tavern-stone py-4">
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
              'grid h-12 w-12 place-items-center rounded-2xl text-lg font-bold transition-all',
              active
                ? 'bg-tavern-ember text-tavern-ink rounded-xl'
                : 'bg-tavern-oak text-tavern-parchment hover:rounded-xl hover:bg-tavern-ember/80 hover:text-tavern-ink',
            )}
          >
            {s.name.slice(0, 2).toUpperCase()}
          </Link>
        );
      })}
      <div className="my-1 h-px w-8 bg-tavern-oak" />
      <button
        aria-label="Add server"
        className="grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-tavern-oak text-tavern-mist hover:bg-tavern-oak hover:rounded-xl"
        title="Create server (use POST /api/servers)"
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
}

function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  activeServerId,
  me,
  onLogout,
}: ChannelSidebarProps): JSX.Element {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-tavern-oak bg-tavern-stone">
      <div className="flex items-center justify-between border-b border-tavern-oak p-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{server?.name ?? '…'}</div>
          {server?.description ? (
            <div className="truncate text-xs text-tavern-mist">{server.description}</div>
          ) : null}
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2 text-sm">
        {activeServerId ? (
          <SidebarSection title="Server">
            <Link
              to="/app/servers/$serverId/campaigns"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-tavern-parchment hover:bg-tavern-oak"
            >
              <span className="text-tavern-mist">
                <Swords size={16} />
              </span>
              <span className="truncate">Campaigns</span>
            </Link>
            <Link
              to="/app/servers/$serverId/games"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-tavern-parchment hover:bg-tavern-oak"
            >
              <span className="text-tavern-mist">
                <Dice5 size={16} />
              </span>
              <span className="truncate">Games &amp; nights</span>
            </Link>
            <Link
              to="/app/servers/$serverId/moderation"
              params={{ serverId: activeServerId }}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-tavern-parchment hover:bg-tavern-oak"
            >
              <span className="text-tavern-mist">
                <Shield size={16} />
              </span>
              <span className="truncate">Moderation</span>
            </Link>
          </SidebarSection>
        ) : null}
        <SidebarSection title="Text">
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
      <footer className="flex items-center justify-between gap-2 border-t border-tavern-oak p-2 text-sm">
        <div className="min-w-0">
          <div className="truncate font-medium">{me?.displayName ?? '—'}</div>
          <div className="truncate text-xs text-tavern-mist">@{me?.username}</div>
        </div>
        <button aria-label="Settings" className="rounded p-1 hover:bg-tavern-oak" title="Settings">
          <Settings size={16} />
        </button>
        <button
          aria-label="Sign out"
          onClick={onLogout}
          className="rounded p-1 hover:bg-tavern-oak"
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="px-2 pb-1 pt-3 text-xs uppercase tracking-wider text-tavern-mist">
        {title}
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
    'flex items-center gap-2 rounded px-2 py-1.5 text-tavern-parchment',
    active ? 'bg-tavern-oak' : 'hover:bg-tavern-oak',
  );
  if (channel.type === 'voice') {
    return (
      <Link
        to="/app/servers/$serverId/voice/$channelId"
        params={{ serverId: channel.serverId, channelId: channel.id }}
        className={className}
      >
        <span className="text-tavern-mist">{icon}</span>
        <span className="truncate">{channel.name}</span>
      </Link>
    );
  }
  return (
    <Link
      to="/app/servers/$serverId/channels/$channelId"
      params={{ serverId: channel.serverId, channelId: channel.id }}
      className={className}
    >
      <span className="text-tavern-mist">{icon}</span>
      <span className="truncate">{channel.name}</span>
    </Link>
  );
}
