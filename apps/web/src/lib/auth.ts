import { create } from 'zustand';
import type {
  BootstrapRequest,
  BootstrapStatus,
  LoginRequest,
  Me,
  RegisterRequest,
  TokenPair,
} from '@tavern/shared';
import { api, ApiError, tokenStore } from './api-client.js';

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
  login: (req: LoginRequest) => Promise<void>;
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

    if (!tokenStore.accessToken && !tokenStore.refreshToken) {
      set({ status: 'unauthenticated', needsBootstrap });
      return;
    }
    try {
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap, error: null });
    } catch (err) {
      tokenStore.clear();
      const msg = err instanceof ApiError ? err.message : 'Could not load profile';
      set({ me: null, status: 'unauthenticated', needsBootstrap, error: msg });
    }
  },

  login: async (req) => {
    set({ status: 'loading', error: null });
    try {
      const { tokens } = await api<{ tokens: TokenPair }>('/auth/login', {
        method: 'POST',
        body: req,
      });
      tokenStore.set(tokens);
      const me = await fetchMe();
      set({ me, status: 'authenticated', needsBootstrap: false, error: null });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Login failed';
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
      const msg = err instanceof ApiError ? err.message : 'Registration failed';
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
      const msg = err instanceof ApiError ? err.message : 'Setup failed';
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
