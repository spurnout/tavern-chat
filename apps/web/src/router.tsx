import { lazy, Suspense } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { LoginPage } from './routes/login.js';
import { RegisterPage } from './routes/register.js';
import { BootstrapPage } from './routes/bootstrap-page.js';
import { AppShell } from './routes/app-shell.js';
import { AppHomePage } from './routes/app-home.js';
import { ChannelPage } from './routes/channel-page.js';
import { VoicePage } from './routes/voice-page.js';
import { ServerHomePage } from './routes/server-home.js';
// FE-21: heavy single-page screens (campaigns 624 LoC, games 581, moderation
// 322, server-settings 582) ship in separate chunks via React.lazy. The first
// visit pays a small additional fetch; subsequent navigations are cached.
// Lighter pages (channel, voice, home) stay in the main bundle so a fresh
// login lands fast.
const CampaignsPage = lazy(() =>
  import('./routes/campaigns-page.js').then((m) => ({ default: m.CampaignsPage })),
);
const GamesPage = lazy(() =>
  import('./routes/games-page.js').then((m) => ({ default: m.GamesPage })),
);
const ModerationPage = lazy(() =>
  import('./routes/moderation-page.js').then((m) => ({ default: m.ModerationPage })),
);
const ServerSettingsPage = lazy(() =>
  import('./routes/server-settings-page.js').then((m) => ({ default: m.ServerSettingsPage })),
);
import { SearchPage } from './routes/search-page.js';
import { AuthGate } from './components/AuthGate.js';
import { useAuth } from './lib/auth.js';

const PageFallback = (): JSX.Element => (
  <div className="grid h-full place-items-center text-sm text-fg-muted">Loading…</div>
);

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    const auth = useAuth.getState();
    if (auth.status === 'authenticated') throw redirect({ to: '/app' });
    if (auth.needsBootstrap === true) throw redirect({ to: '/bootstrap' });
    throw redirect({ to: '/login' });
  },
});

const bootstrapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bootstrap',
  component: BootstrapPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
});

const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: () => (
    <AuthGate>
      <AppShell />
    </AuthGate>
  ),
});

const appHomeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app',
  component: AppHomePage,
});

const serverHomeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId',
  component: ServerHomePage,
});

const channelRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/channels/$channelId',
  component: ChannelPage,
});

const voiceRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/voice/$channelId',
  component: VoicePage,
});

const campaignsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/campaigns',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <CampaignsPage />
    </Suspense>
  ),
});

const gamesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/games',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <GamesPage />
    </Suspense>
  ),
});

const moderationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/moderation',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <ModerationPage />
    </Suspense>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/settings',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <ServerSettingsPage />
    </Suspense>
  ),
});

const searchRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/search',
  component: SearchPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  bootstrapRoute,
  loginRoute,
  registerRoute,
  appLayoutRoute.addChildren([
    appHomeRoute,
    serverHomeRoute,
    channelRoute,
    voiceRoute,
    campaignsRoute,
    gamesRoute,
    moderationRoute,
    settingsRoute,
    searchRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
