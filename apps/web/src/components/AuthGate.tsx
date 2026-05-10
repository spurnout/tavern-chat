import { useEffect, type ReactNode } from 'react';
import { Navigate } from '@tanstack/react-router';
import { useAuth } from '../lib/auth.js';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps): JSX.Element {
  const { status, bootstrap } = useAuth();

  useEffect(() => {
    if (status === 'idle') void bootstrap();
  }, [status, bootstrap]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="grid h-full place-items-center text-fg-muted">
        <span className="animate-pulse text-sm">Loading…</span>
      </div>
    );
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
