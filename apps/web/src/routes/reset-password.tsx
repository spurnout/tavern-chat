import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { TavernLogo } from '../components/TavernLogo.js';
import { api, ApiError } from '../lib/api-client.js';

/**
 * Anonymous self-service password reset, step 2.
 *
 * Reads the opaque token from `?token=…` on the URL and lets the user pick a
 * new password. On success, all sessions for the account are revoked
 * (server-side) so the user is bounced back to /login to sign in afresh.
 */
export function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [missingToken, setMissingToken] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // TanStack Router exposes search params via the route definition, but the
    // simpler URLSearchParams works for a one-off anonymous page that doesn't
    // need typed search state.
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (!t) {
      setMissingToken(true);
      return;
    }
    setToken(t);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: password },
        retryOn401: false,
      });
      setDone(true);
      // Give the user a moment to read the success state, then send them to
      // sign in. All their sessions were revoked server-side so any cached
      // refresh cookie is already dead.
      setTimeout(() => {
        void navigate({ to: '/login', replace: true });
      }, 1500);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reach the server. Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <TavernLogo className="mb-8" />
        {missingToken ? (
          <div className="card space-y-4">
            <h1 className="font-serif text-xl font-medium">Link is missing a token</h1>
            <p className="text-sm text-fg-muted">
              This page expects a reset token in the URL. Open the link from your
              reset email, or start over below.
            </p>
            <Link to="/forgot-password" className="btn-primary block w-full text-center">
              Request a new link
            </Link>
          </div>
        ) : done ? (
          <div className="card space-y-4">
            <h1 className="font-serif text-xl font-medium">Password updated</h1>
            <p className="text-sm text-fg-muted">
              Sending you to sign in…
            </p>
          </div>
        ) : (
          <form className="card space-y-4" onSubmit={onSubmit}>
            <h1 className="font-serif text-xl font-medium">Choose a new password</h1>
            <p className="text-sm text-fg-muted">
              Pick a password you haven&apos;t used before. Signing in with the new
              password will sign out all your other devices.
            </p>
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">New password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">Confirm</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <button className="btn-primary w-full" type="submit" disabled={busy || !token}>
              {busy ? 'Setting password…' : 'Set new password'}
            </button>
            <p className="text-center text-sm text-fg-muted">
              <Link to="/login" className="text-mead hover:underline">
                Back to sign-in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
