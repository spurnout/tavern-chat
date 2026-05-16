import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { TavernLogo } from '../components/TavernLogo.js';
import { api, ApiError } from '../lib/api-client.js';

/**
 * Anonymous self-service password reset, step 1.
 *
 * Posts the supplied address to /api/auth/forgot-password and renders a
 * generic confirmation regardless of the response. The API never confirms
 * whether the address is a known account, so this page must not either —
 * otherwise the UI becomes the enumeration oracle the backend works hard
 * to deny.
 */
export function ForgotPasswordPage(): JSX.Element {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setNetworkError(null);
    try {
      await api('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
        retryOn401: false,
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Rate-limited. Telling the user "too many attempts" doesn't leak
        // any account-existence signal so it's safe to surface.
        setNetworkError(
          'Too many requests right now — wait a few minutes and try again.',
        );
      } else if (err instanceof ApiError) {
        setNetworkError(err.message);
      } else {
        setNetworkError('Could not reach the server. Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <TavernLogo className="mb-8" />
        {submitted ? (
          <div className="card space-y-4">
            <h1 className="font-serif text-xl font-medium">Check your mail</h1>
            <p className="text-sm text-fg-muted">
              If an account exists for that address, a reset link is on its way.
              The link works for a limited time — open it from the device you
              want to sign in on.
            </p>
            <Link to="/login" className="btn-primary block w-full text-center">
              Back to sign-in
            </Link>
          </div>
        ) : (
          <form className="card space-y-4" onSubmit={onSubmit}>
            <h1 className="font-serif text-xl font-medium">Reset your password</h1>
            <p className="text-sm text-fg-muted">
              Enter the email tied to your Tavern account and we&apos;ll send a
              link to set a new password.
            </p>
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">Email</span>
              <input
                className="input"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            {networkError ? <p className="text-sm text-danger">{networkError}</p> : null}
            <button className="btn-primary w-full" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <p className="text-center text-sm text-fg-muted">
              Remembered it?{' '}
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
