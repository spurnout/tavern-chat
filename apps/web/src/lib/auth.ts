import { create } from 'zustand';
import { startAuthentication } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import type {
  BootstrapRequest,
  BootstrapStatus,
  LoginRequest,
  Me,
  RegisterRequest,
  TokenPair,
} from '@tavern/shared';
import { api, ApiError, tokenStore } from './api-client.js';
import { authErrorMessage } from './auth-error.js';

interface AuthState {
  me: Me | null;
  status: 'idle' | 'loading' | 'authenticated' | 'unauthenticated' | 'error';
  error: string | null;
  /**
   * Whether the instance has zero users yet. Drives the "first run setup"
   * UI: when true, login/register pages redirect to /bootstrap instead.
   * `null` = not yet checked.
   */
  needsBootstrap: boolean | null;
  bootstrap: () => Promise<void>;
  login: (req: LoginRequest) => Promise<{ totpRequired: true; stagedToken: string } | { totpRequired: false }>;
  loginTotp: (stagedToken: string, code: string) => Promise<void>;
  /**
   * Passwordless login via an enrolled WebAuthn passkey. Caller supplies
   * just the identifier (username or email); the browser handles the
   * authenticator dance.
   */
  loginWebauthn: (identifier: string) => Promise<void>;
  register: (req: RegisterRequest) => Promise<void>;
  bootstrapAdmin: (req: BootstrapRequest) => Promise<void>;
  logout: () => Promise<void>;
}

async function fetchMe(): Promise<Me> {
  return api<Me>('/auth/me');
}

async function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  return api<BootstrapStatus>('/auth/bootstrap-status', { retryOn401: false });
}

export const useAuth = create<AuthState>((set) => ({
  me: null,
  status: 'idle',
  error: null,
  needsBootstrap: null,

  bootstrap: async () => {
    // Always check bootstrap status (cheap, unauthenticated). If we have
    // tokens, also fetch /me. Order: status check first so we know whether
    // the unauth-redirect target is /bootstrap or /login.
    set({ status: 'loading', error: null });
    let needsBootstrap: boolean | null = null;
    try {
      const status = await fetchBootstrapStatus();
      needsBootstrap = status.needsBootstrap;
    } catch {
      needsBootstrap = false; // be lenient — if the API is down, fall through to login
    }

    // After SEC-001/FE-02 the refresh token lives in an httpOnly cookie we
    // can't see from JS. The sessionHint expiry tells us we likely have an
    // access token in memory; if we don't (page reload), the api() 401
    // handler will try to refresh from the cookie automatically. Either way,
    // attempting /auth/me is the cheapest "do I have a session?" probe.
    try {
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap, error: null });
    } catch (err) {
      tokenStore.clear();
      const msg = err instanceof ApiError ? err.message : null;
      set({ me: null, status: 'unauthenticated', needsBootstrap, error: msg });
    }
  },

  login: async (req) => {
    set({ status: 'loading', error: null });
    try {
      const resp = await api<
        { tokens: TokenPair } | { totpRequired: true; stagedToken: string }
      >('/auth/login', { method: 'POST', body: req });
      if ('totpRequired' in resp && resp.totpRequired) {
        // Stay in `loading` so the UI shows the 2FA step. The component
        // calls `loginTotp` next.
        set({ status: 'idle', error: null });
        return { totpRequired: true, stagedToken: resp.stagedToken };
      }
      if (!('tokens' in resp)) {
        throw new Error('Unexpected login response shape');
      }
      tokenStore.set(resp.tokens);
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap: false, error: null });
      return { totpRequired: false };
    } catch (err) {
      const msg = authErrorMessage(err, 'Login failed');
      set({ status: 'error', error: msg });
      throw err;
    }
  },

  loginTotp: async (stagedToken, code) => {
    set({ status: 'loading', error: null });
    try {
      const { tokens } = await api<{ tokens: TokenPair }>('/auth/login/totp', {
        method: 'POST',
        body: { stagedToken, code },
      });
      tokenStore.set(tokens);
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap: false, error: null });
    } catch (err) {
      const msg = authErrorMessage(err, 'Code did not match');
      set({ status: 'error', error: msg });
      throw err;
    }
  },

  loginWebauthn: async (identifier) => {
    set({ status: 'loading', error: null });
    try {
      const start = await api<{
        stagedToken: string;
        options: PublicKeyCredentialRequestOptionsJSON;
        hasCredentials: boolean;
      }>('/auth/login/webauthn/options', {
        method: 'POST',
        body: { identifier },
        retryOn401: false,
      });
      if (!start.hasCredentials) {
        // The API intentionally returns a still-shaped challenge here to
        // avoid leaking which usernames are registered; the helper would
        // hang waiting for an authenticator that has no matching credential.
        throw new ApiError('NOT_FOUND', 'No passkey is registered for this account.', 404);
      }
      const assertion: AuthenticationResponseJSON = await startAuthentication({
        optionsJSON: start.options,
      });
      const { tokens } = await api<{ tokens: TokenPair }>('/auth/login/webauthn/verify', {
        method: 'POST',
        body: { stagedToken: start.stagedToken, response: assertion },
        retryOn401: false,
      });
      tokenStore.set(tokens);
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap: false, error: null });
    } catch (err) {
      // The DOMException "NotAllowedError" fires when the user cancels the
      // platform prompt — surface that quietly rather than as a hard error.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        set({ status: 'idle', error: null });
        return;
      }
      const msg = authErrorMessage(err, 'Passkey sign-in failed');
      set({ status: 'error', error: msg });
      throw err;
    }
  },

  register: async (req) => {
    set({ status: 'loading', error: null });
    try {
      const { tokens } = await api<{ tokens: TokenPair }>('/auth/register', {
        method: 'POST',
        body: req,
      });
      tokenStore.set(tokens);
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap: false, error: null });
    } catch (err) {
      const msg = authErrorMessage(err, 'Registration failed');
      set({ status: 'error', error: msg });
      throw err;
    }
  },

  bootstrapAdmin: async (req) => {
    set({ status: 'loading', error: null });
    try {
      const { tokens } = await api<{ tokens: TokenPair }>('/auth/bootstrap', {
        method: 'POST',
        body: req,
      });
      tokenStore.set(tokens);
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap: false, error: null });
    } catch (err) {
      const msg = authErrorMessage(err, 'Setup failed');
      set({ status: 'error', error: msg });
      throw err;
    }
  },

  logout: async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* even if the server hiccups, drop client state */
    }
    tokenStore.clear();
    // Don't reset needsBootstrap here — it's a property of the instance,
    // not the session. Will be re-fetched on next bootstrap() call.
    set({ me: null, status: 'unauthenticated', error: null });
  },
}));
