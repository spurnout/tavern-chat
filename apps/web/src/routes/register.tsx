import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { TavernLogo } from '../components/TavernLogo.js';
import { useAuth } from '../lib/auth.js';

export function RegisterPage(): JSX.Element {
  const register = useAuth((s) => s.register);
  const refreshAuth = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const needsBootstrap = useAuth((s) => s.needsBootstrap);
  const navigate = useNavigate();

  useEffect(() => {
    if (status === 'idle') void refreshAuth();
  }, [status, refreshAuth]);

  // Fresh instance: send to /bootstrap instead of asking for an invite that
  // doesn't exist yet.
  useEffect(() => {
    if (needsBootstrap === true) {
      void navigate({ to: '/bootstrap', replace: true });
    }
  }, [needsBootstrap, navigate]);

  const [form, setForm] = useState({
    username: '',
    displayName: '',
    email: '',
    password: '',
    inviteCode: '',
  });

  function bind<K extends keyof typeof form>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    };
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    try {
      await register(form);
      await navigate({ to: '/app' });
    } catch {
      /* error surfaced via store */
    }
  }

  const busy = status === 'loading';

  return (
    <div className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <TavernLogo className="mb-8" />
        <form className="card space-y-4" onSubmit={onSubmit}>
          <h1 className="text-xl font-semibold">Pull up a chair</h1>
          <p className="text-sm text-tavern-mist">
            Tavern is invite-only. Enter the code your innkeeper gave you.
          </p>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Invite code</span>
            <input className="input font-mono uppercase" required disabled={busy} {...bind('inviteCode')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Username</span>
            <input className="input" required disabled={busy} {...bind('username')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Display name</span>
            <input className="input" required disabled={busy} {...bind('displayName')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Email</span>
            <input className="input" type="email" required disabled={busy} {...bind('email')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-tavern-mist">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              disabled={busy}
              {...bind('password')}
            />
          </label>

          {error && status === 'error' ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : null}

          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>

          <p className="text-center text-sm text-tavern-mist">
            Already have an account?{' '}
            <Link to="/login" className="text-tavern-mead hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
