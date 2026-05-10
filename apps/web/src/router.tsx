import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { LoginPage } from './routes/login.js';
import { RegisterPage } from './routes/register.js';
import { AppShell } from './routes/app-shell.js';
import { AppHomePage } from './routes/app-home.js';
import { ChannelPage } from './routes/channel-page.js';
import { VoicePage } from './routes/voice-page.js';
import { ServerHomePage } from './routes/server-home.js';
import { CampaignsPage } from './routes/campaigns-page.js';
import { GamesPage } from './routes/games-page.js';
import { ModerationPage } from './routes/moderation-page.js';
import { ServerSettingsPage } from './routes/server-settings-page.js';
import { SearchPage } from './routes/search-page.js';
import { AuthGate } from './components/AuthGate.js';
import { useAuth } from './lib/auth.js';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    const status = useAuth.getState().status;
    throw redirect({ to: status === 'authenticated' ? '/app' : '/login' });
  },
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
  component: CampaignsPage,
});

const gamesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/games',
  component: GamesPage,
});

const moderationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/moderation',
  component: ModerationPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/settings',
  component: ServerSettingsPage,
});

const searchRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/app/servers/$serverId/search',
  component: SearchPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
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
