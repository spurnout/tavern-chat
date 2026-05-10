import { useEffect } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { Hash, LogOut, Plus, Settings, Volume2 } from 'lucide-react';
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

  // Boot: start gateway + load servers.
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

  // Whenever the active server changes, fetch its channels.
  useEffect(() => {
    if (!params.serverId) return;
    api<Channel[]>(`/servers/${params.serverId}/channels`)
      .then((channels) => upsertChannels(params.serverId!, channels))
      .catch(() => undefined);
  }, [params.serverId, upsertChannels]);

  const activeServer = params.serverId ? servers.find((s) => s.id === params.serverId) : null;
  const channels = params.serverId ? (channelsByServer[params.serverId] ?? []) : [];

  return (
    <div className="grid h-full grid-cols-[72px_240px_1fr] bg-tavern-ink text-tavern-parchment">
      {/* Server rail */}
      <aside className="flex flex-col items-center gap-3 overflow-y-auto border-r border-tavern-oak bg-tavern-stone py-4">
        {servers.map((s) => {
          const active = s.id === params.serverId;
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
          title="Create server (coming soon)"
        >
          <Plus size={18} />
        </button>
      </aside>

      {/* Channel sidebar */}
      <aside className="flex flex-col border-r border-tavern-oak bg-tavern-stone">
        <div className="flex items-center justify-between border-b border-tavern-oak p-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{activeServer?.name ?? '…'}</div>
            {activeServer?.description ? (
              <div className="truncate text-xs text-tavern-mist">{activeServer.description}</div>
            ) : null}
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2 text-sm">
          <SidebarSection title="Text">
            {channels
              .filter((c) => c.type === 'text')
              .map((c) => (
                <SidebarChannelLink
                  key={c.id}
                  channel={c}
                  icon={<Hash size={16} />}
                  active={c.id === params.channelId}
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
                  active={c.id === params.channelId}
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
            onClick={() => void logout()}
            className="rounded p-1 hover:bg-tavern-oak"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </footer>
      </aside>

      <main className="flex min-w-0 flex-col">
        <Outlet />
      </main>
    </div>
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
