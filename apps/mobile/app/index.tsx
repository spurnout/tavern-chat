import type { JSX } from 'react';
import { useEffect } from 'react';
import { LoadingScreen } from '@/components/LoadingScreen';
import { AuthScreen } from '@/screens/AuthScreen';
import { BootstrapScreen } from '@/screens/BootstrapScreen';
import { InstanceConnectScreen } from '@/screens/InstanceConnectScreen';
import { TavernHomeScreen } from '@/screens/TavernHomeScreen';
import { useAuthStore } from '@/stores/auth-store';

export default function IndexRoute(): JSX.Element {
  const hydrated = useAuthStore((state) => state.hydrated);
  const status = useAuthStore((state) => state.status);
  const instanceUrl = useAuthStore((state) => state.instanceUrl);
  const needsBootstrap = useAuthStore((state) => state.needsBootstrap);
  const hydrate = useAuthStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated || status === 'booting' || (status === 'checking' && !instanceUrl)) {
    return <LoadingScreen />;
  }

  if (!instanceUrl || status === 'instance-needed') {
    return <InstanceConnectScreen />;
  }

  if (needsBootstrap) {
    return <BootstrapScreen />;
  }

  if (status === 'authenticated') {
    return <TavernHomeScreen />;
  }

  return <AuthScreen />;
}
