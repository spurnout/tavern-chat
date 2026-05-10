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

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  appLayoutRoute.addChildren([appHomeRoute, serverHomeRoute, channelRoute, voiceRoute]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
