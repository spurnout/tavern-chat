import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { TavernLogo } from '../components/TavernLogo.js';
import { useAuth } from '../lib/auth.js';

/**
 * First-run setup page.
 *
 * Reachable when /api/auth/bootstrap-status reports needsBootstrap=true.
 * Once a user is created here, every subsequent visit to /bootstrap
 * redirects to /login because the endpoint will refuse a second call.
 */
export function BootstrapPage(): JSX.Element {
  const bootstrapAdmin = useAuth((s) => s.bootstrapAdmin);
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const needsBootstrap = useAuth((s) => s.needsBootstrap);
  const refreshBootstrap = useAuth((s) => s.bootstrap);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    username: 'admin',
    displayName: '',
    email: '',
    password: '',
    serverName: 'The Tavern',
  });

  function bind<K extends keyof typeof form>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    };
  }

  // If the instance is already initialised, bounce to /login.
  useEffect(() => {
    if (needsBootstrap === null) {
      void refreshBootstrap();
      return;
    }
    if (needsBootstrap === false && status !== 'authenticated') {
      void navigate({ to: '/login', replace: true });
    }
  }, [needsBootstrap, status, refreshBootstrap, navigate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    try {
      await bootstrapAdmin(form);
      await navigate({ to: '/app' });
    } catch {
      /* error surfaced via store */
    }
  }

  const busy = status === 'loading';
  const ready = needsBootstrap === true;

  if (needsBootstrap === null) {
    return (
      <div className="grid min-h-screen place-items-center text-tavern-mist">
        <span className="animate-pulse text-sm">Checking instance…</span>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <TavernLogo className="mb-8" />
        <form className="card space-y-4" onSubmit={onSubmit}>
          <div>
            <h1 className="text-xl font-semibold">First time here</h1>
            <p className="mt-1 text-sm text-tavern-mist">
              No accounts exist yet. Create the instance owner — this account is the
              first administrator and will be able to invite everyone else.
            </p>
          </div>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Username</span>
            <input className="input" required disabled={busy || !ready} {...bind('username')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Display name</span>
            <input
              className="input"
              required
              placeholder="What other people see"
              disabled={busy || !ready}
              {...bind('displayName')}
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Email</span>
            <input
              className="input"
              type="email"
              required
              disabled={busy || !ready}
              {...bind('email')}
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              disabled={busy || !ready}
              {...bind('password')}
            />
            <span className="mt-1 inline-block text-xs text-tavern-mist">
              Minimum 8 characters. Pick something you'll remember.
            </span>
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Server name</span>
            <input
              className="input"
              required
              disabled={busy || !ready}
              {...bind('serverName')}
            />
            <span className="mt-1 inline-block text-xs text-tavern-mist">
              We'll create your first server with a #lobby and a Voice Hall.
            </span>
          </label>

          {error && status === 'error' ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : null}

          <button
            className="btn-primary w-full"
            type="submit"
            disabled={busy || !ready}
          >
            {busy ? 'Setting up…' : 'Create admin account'}
          </button>

          <p className="text-center text-xs text-tavern-mist">
            This screen disappears once an account exists. Future signups need
            an invite from an admin.
          </p>
        </form>
      </div>
    </div>
  );
}
