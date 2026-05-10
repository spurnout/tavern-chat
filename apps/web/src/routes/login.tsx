import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { TavernLogo } from '../components/TavernLogo.js';
import { useAuth } from '../lib/auth.js';

export function LoginPage(): JSX.Element {
  const login = useAuth((s) => s.login);
  const refreshAuth = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const needsBootstrap = useAuth((s) => s.needsBootstrap);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  // Run the unauthenticated bootstrap-status + /me check once on mount.
  useEffect(() => {
    if (status === 'idle') void refreshAuth();
  }, [status, refreshAuth]);

  // If the instance is fresh, send the user to setup instead.
  useEffect(() => {
    if (needsBootstrap === true) {
      void navigate({ to: '/bootstrap', replace: true });
    }
  }, [needsBootstrap, navigate]);

  // Already signed in? Skip ahead.
  useEffect(() => {
    if (status === 'authenticated') {
      void navigate({ to: '/app', replace: true });
    }
  }, [status, navigate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    try {
      await login({ identifier, password });
      await navigate({ to: '/app' });
    } catch {
      /* error surfaced via store */
    }
  }

  const busy = status === 'loading';

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <TavernLogo className="mb-8" />
        <form className="card space-y-4" onSubmit={onSubmit}>
          <h1 className="text-xl font-semibold">Welcome back</h1>
          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Username or email</span>
            <input
              className="input"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          {error && status === 'error' ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : null}
          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-center text-sm text-tavern-mist">
            Have an invite?{' '}
            <Link to="/register" className="text-tavern-mead hover:underline">
              Create an account
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
