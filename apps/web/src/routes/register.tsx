import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { TavernLogo } from '../components/TavernLogo.js';
import { useAuth } from '../lib/auth.js';
import {
  clearPendingInvite,
  normalizeInviteCode,
  pendingInviteMatchesCode,
  readPendingInvite,
  shouldResumePendingInviteAfterRegistration,
} from '../lib/pending-invite.js';

function inviteCodeFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const query = new URLSearchParams(window.location.search);
  return normalizeInviteCode(query.get('inviteCode') ?? query.get('invite') ?? '');
}

export function RegisterPage(): JSX.Element {
  const register = useAuth((s) => s.register);
  const refreshAuth = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const needsBootstrap = useAuth((s) => s.needsBootstrap);
  const navigate = useNavigate();
  const [initialInviteCode, setInitialInviteCode] = useState(() => {
    const queryCode = inviteCodeFromLocation();
    return queryCode || readPendingInvite()?.code || '';
  });

  useEffect(() => {
    if (status === 'idle') void refreshAuth();
  }, [status, refreshAuth]);

  useEffect(() => {
    const queryCode = inviteCodeFromLocation();
    const pendingCode = readPendingInvite()?.code ?? '';
    const next = queryCode || pendingCode;
    if (next) setInitialInviteCode(next);
  }, []);

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
    inviteCode: initialInviteCode,
  });

  useEffect(() => {
    if (!initialInviteCode) return;
    setForm((f) => (f.inviteCode ? f : { ...f, inviteCode: initialInviteCode }));
  }, [initialInviteCode]);

  function bind<K extends keyof typeof form>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    };
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const req = { ...form, inviteCode: normalizeInviteCode(form.inviteCode) };
    try {
      await register(req);
      const pending = readPendingInvite();
      if (pending) {
        clearPendingInvite();
        if (
          pendingInviteMatchesCode(pending, req.inviteCode) &&
          shouldResumePendingInviteAfterRegistration(pending)
        ) {
          window.location.assign(pending.path);
          return;
        }
      }
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
          <h1 className="font-serif text-xl font-medium">Pull up a chair</h1>
          <p className="text-sm text-fg-muted">
            Tavern is invite-only. Enter the code your innkeeper gave you.
          </p>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Invite code</span>
            <input
              className="input font-mono uppercase"
              required
              disabled={busy}
              {...bind('inviteCode')}
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Username</span>
            <input className="input" required disabled={busy} {...bind('username')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Display name</span>
            <input className="input" required disabled={busy} {...bind('displayName')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Email</span>
            <input className="input" type="email" required disabled={busy} {...bind('email')} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Password</span>
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

          {error && status === 'error' ? <p className="text-sm text-danger">{error}</p> : null}

          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>

          <p className="text-center text-sm text-fg-muted">
            Already have an account?{' '}
            <Link to="/login" className="text-mead hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
