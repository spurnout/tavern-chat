import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { TavernLogo } from '../components/TavernLogo.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { useAuth } from '../lib/auth.js';
import { api } from '../lib/api-client.js';
import { clearPendingInvite, readPendingInvite } from '../lib/pending-invite.js';

export function LoginPage(): JSX.Element {
  const login = useAuth((s) => s.login);
  const loginTotp = useAuth((s) => s.loginTotp);
  const loginWebauthn = useAuth((s) => s.loginWebauthn);
  const refreshAuth = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const instanceError = useAuth((s) => s.instanceError);
  const needsBootstrap = useAuth((s) => s.needsBootstrap);
  const [identifier, setIdentifier] = useState('');
  const identifierRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [stagedToken, setStagedToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const navigate = useNavigate();
  const webauthnSupported = browserSupportsWebAuthn();

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

  const continueAfterAuth = useCallback((): boolean => {
    const pending = readPendingInvite();
    if (!pending) return false;
    clearPendingInvite();
    window.location.assign(pending.path);
    return true;
  }, []);

  // Already signed in? Skip ahead.
  useEffect(() => {
    if (status === 'authenticated') {
      if (continueAfterAuth()) return;
      void navigate({ to: '/app', replace: true });
    }
  }, [continueAfterAuth, status, navigate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    try {
      const r = await login({ identifier, password });
      if (r.totpRequired) {
        setStagedToken(r.stagedToken);
        return;
      }
      if (continueAfterAuth()) return;
      await navigate({ to: '/app' });
    } catch {
      /* error surfaced via store */
    }
  }

  async function onSubmitTotp(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!stagedToken) return;
    try {
      await loginTotp(stagedToken, code.trim());
      if (continueAfterAuth()) return;
      await navigate({ to: '/app' });
    } catch {
      /* error surfaced via store */
    }
  }

  async function onPasskeySignIn(): Promise<void> {
    if (!identifier.trim()) {
      // The button stays reachable (not disabled) so it's operable by keyboard
      // and screen readers; clicking it empty points the user at what's needed.
      identifierRef.current?.focus();
      return;
    }
    try {
      await loginWebauthn(identifier.trim());
      // If the user cancelled the platform prompt the store leaves us idle
      // without an error; only navigate when we actually got a session.
      if (useAuth.getState().status === 'authenticated') {
        if (continueAfterAuth()) return;
        await navigate({ to: '/app' });
      }
    } catch {
      /* error surfaced via store */
    }
  }

  const busy = status === 'loading';
  const displayedError = instanceError ?? error;

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <TavernLogo className="mb-8 justify-center" />
        {stagedToken ? (
          <form className="card space-y-4" onSubmit={onSubmitTotp}>
            <h1 className="font-serif text-xl font-medium">Two-factor code</h1>
            <p className="text-sm text-fg-muted">
              Open your authenticator app and enter the 6-digit code. Backup codes work here too.
            </p>
            <input
              className="input font-mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              aria-label="Two-factor code"
              maxLength={20}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              disabled={busy}
              aria-invalid={status === 'error'}
            />
            {displayedError && status === 'error' ? <ErrorAlert>{displayedError}</ErrorAlert> : null}
            <button className="btn-primary w-full" type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              className="btn-ghost w-full text-sm"
              onClick={() => {
                setStagedToken(null);
                setCode('');
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <form className="card space-y-4" onSubmit={onSubmit}>
            <h1 className="font-serif text-xl font-medium">Welcome back</h1>
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">Username or email</span>
              <input
                ref={identifierRef}
                className="input"
                autoComplete="username"
                aria-label="Username or email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 inline-block text-fg-muted">Password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={busy}
                aria-invalid={status === 'error'}
              />
            </label>
            {displayedError && status === 'error' ? <ErrorAlert>{displayedError}</ErrorAlert> : null}
            <button className="btn-primary w-full" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            {webauthnSupported ? (
              <div className="space-y-1">
                <button
                  type="button"
                  className="btn-ghost w-full"
                  onClick={() => void onPasskeySignIn()}
                  disabled={busy}
                  aria-describedby={!identifier.trim() ? 'passkey-hint' : undefined}
                >
                  <KeyRound size={14} className="mr-1.5 inline-block" />
                  Sign in with passkey
                </button>
                {!identifier.trim() ? (
                  <p id="passkey-hint" className="text-center text-xs text-fg-muted">
                    Enter your username above to use a passkey.
                  </p>
                ) : null}
              </div>
            ) : null}
            <SsoSignInButton />
            <p className="text-center text-sm">
              <Link to="/forgot-password" className="text-dusk hover:underline">
                Forgot your password?
              </Link>
            </p>
            <p className="text-center text-sm text-fg-muted">
              Have an invite?{' '}
              <Link to="/register" className="text-dusk hover:underline">
                Create an account
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Wave 3 #36 — SSO button. Hidden when the instance hasn't configured
 * OIDC. Clicking redirects the browser to `/api/auth/sso/start`, which is
 * a server-side 302 to the IdP — not a fetch.
 */
function SsoSignInButton(): JSX.Element | null {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState('Sign in with SSO');
  useEffect(() => {
    let cancelled = false;
    api<{
      features: { ssoEnabled?: boolean; ssoButtonLabel?: string };
    }>('/instance', { retryOn401: false })
      .then((r) => {
        if (cancelled) return;
        if (r.features.ssoEnabled) setEnabled(true);
        if (r.features.ssoButtonLabel) setLabel(r.features.ssoButtonLabel);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!enabled) return null;
  return (
    <a href="/api/auth/sso/start" className="btn-ghost block w-full text-center">
      <LogIn size={14} className="mr-1.5 inline-block" />
      {label}
    </a>
  );
}
