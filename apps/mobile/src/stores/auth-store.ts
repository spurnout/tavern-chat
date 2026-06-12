import { create } from 'zustand';
import type {
  BootstrapRequest,
  BootstrapStatus,
  LoginRequest,
  Me,
  RegisterRequest,
  TokenPair,
} from '@tavern/shared/schemas';
import {
  ApiError,
  normalizeInstanceUrl,
  rawRequest,
  type RequestOptions,
  type TavernInstanceInfo,
} from '@/lib/api-client';
import {
  clearStoredSession,
  clearStoredTokens,
  readStoredSession,
  writeAccessExpiry,
  writeInstanceUrl,
  writeRefreshToken,
} from '@/lib/session-storage';

type AuthStatus =
  | 'booting'
  | 'checking'
  | 'instance-needed'
  | 'unauthenticated'
  | 'totp-required'
  | 'authenticated'
  | 'error';

type LoginResponse =
  | { tokens: TokenPair }
  | { totpRequired: true; stagedToken: string };

interface AuthState {
  hydrated: boolean;
  status: AuthStatus;
  instanceUrl: string | null;
  instanceInfo: TavernInstanceInfo | null;
  needsBootstrap: boolean | null;
  me: Me | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  stagedTotpToken: string | null;
  error: string | null;
  hydrate: () => Promise<void>;
  setInstanceUrl: (input: string) => Promise<void>;
  resetInstance: () => Promise<void>;
  login: (req: LoginRequest) => Promise<void>;
  loginTotp: (code: string) => Promise<void>;
  register: (req: RegisterRequest) => Promise<void>;
  bootstrapAdmin: (req: BootstrapRequest) => Promise<void>;
  refresh: () => Promise<boolean>;
  logout: () => Promise<void>;
  api: <T>(path: string, opts?: RequestOptions) => Promise<T>;
  clearError: () => void;
  applyTokens: (tokens: TokenPair) => Promise<void>;
}

let refreshInflight: Promise<boolean> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  status: 'booting',
  instanceUrl: null,
  instanceInfo: null,
  needsBootstrap: null,
  me: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  refreshToken: null,
  stagedTotpToken: null,
  error: null,

  hydrate: async () => {
    set({ hydrated: false, status: 'checking', error: null });
    try {
      const stored = await readStoredSession();
      if (!stored.instanceUrl) {
        set({ hydrated: true, status: 'instance-needed' });
        return;
      }
      const instanceInfo = await rawRequest<TavernInstanceInfo>(
        stored.instanceUrl,
        '/instance',
        { retryOn401: false },
      );
      const bootstrap = await rawRequest<BootstrapStatus>(
        stored.instanceUrl,
        '/auth/bootstrap-status',
        { retryOn401: false },
      );
      set({
        hydrated: true,
        instanceUrl: stored.instanceUrl,
        instanceInfo,
        needsBootstrap: bootstrap.needsBootstrap,
        refreshToken: stored.refreshToken,
        accessTokenExpiresAt: stored.accessTokenExpiresAt,
        status: bootstrap.needsBootstrap ? 'unauthenticated' : 'checking',
      });
      if (stored.refreshToken) {
        const ok = await get().refresh();
        if (ok) return;
      }
      set({ status: 'unauthenticated', me: null, accessToken: null });
    } catch (err) {
      set({
        hydrated: true,
        status: 'error',
        error: errorMessage(err, 'Could not reach this Tavern instance.'),
      });
    }
  },

  setInstanceUrl: async (input) => {
    set({ status: 'checking', error: null });
    try {
      const instanceUrl = normalizeInstanceUrl(input);
      const [instanceInfo, bootstrap] = await Promise.all([
        rawRequest<TavernInstanceInfo>(instanceUrl, '/instance', { retryOn401: false }),
        rawRequest<BootstrapStatus>(instanceUrl, '/auth/bootstrap-status', {
          retryOn401: false,
        }),
      ]);
      await writeInstanceUrl(instanceUrl);
      set({
        hydrated: true,
        status: 'unauthenticated',
        instanceUrl,
        instanceInfo,
        needsBootstrap: bootstrap.needsBootstrap,
        me: null,
        accessToken: null,
        accessTokenExpiresAt: null,
        refreshToken: null,
        stagedTotpToken: null,
        error: null,
      });
    } catch (err) {
      set({
        status: 'instance-needed',
        error: errorMessage(err, 'Could not connect to that Tavern.'),
      });
      throw err;
    }
  },

  resetInstance: async () => {
    await clearStoredSession();
    refreshInflight = null;
    set({
      hydrated: true,
      status: 'instance-needed',
      instanceUrl: null,
      instanceInfo: null,
      needsBootstrap: null,
      me: null,
      accessToken: null,
      accessTokenExpiresAt: null,
      refreshToken: null,
      stagedTotpToken: null,
      error: null,
    });
  },

  login: async (req) => {
    const { instanceUrl } = get();
    if (!instanceUrl) throw new Error('No Tavern instance is configured.');
    set({ status: 'checking', error: null, stagedTotpToken: null });
    try {
      const response = await rawRequest<LoginResponse>(instanceUrl, '/auth/login', {
        method: 'POST',
        body: req,
        retryOn401: false,
      });
      if ('totpRequired' in response && response.totpRequired) {
        set({
          status: 'totp-required',
          stagedTotpToken: response.stagedToken,
          error: null,
        });
        return;
      }
      if ('tokens' in response) {
        await get().applyTokens(response.tokens);
        return;
      }
      throw new Error('Unexpected login response.');
    } catch (err) {
      set({ status: 'unauthenticated', error: errorMessage(err, 'Login failed.') });
      throw err;
    }
  },

  loginTotp: async (code) => {
    const { instanceUrl, stagedTotpToken } = get();
    if (!instanceUrl || !stagedTotpToken) throw new Error('No staged login is active.');
    set({ status: 'checking', error: null });
    try {
      const response = await rawRequest<{ tokens: TokenPair }>(instanceUrl, '/auth/login/totp', {
        method: 'POST',
        body: { stagedToken: stagedTotpToken, code },
        retryOn401: false,
      });
      await get().applyTokens(response.tokens);
    } catch (err) {
      set({ status: 'totp-required', error: errorMessage(err, 'Code did not match.') });
      throw err;
    }
  },

  register: async (req) => {
    const { instanceUrl } = get();
    if (!instanceUrl) throw new Error('No Tavern instance is configured.');
    set({ status: 'checking', error: null });
    try {
      const response = await rawRequest<{ tokens: TokenPair }>(instanceUrl, '/auth/register', {
        method: 'POST',
        body: req,
        retryOn401: false,
      });
      await get().applyTokens(response.tokens);
    } catch (err) {
      set({ status: 'unauthenticated', error: errorMessage(err, 'Registration failed.') });
      throw err;
    }
  },

  bootstrapAdmin: async (req) => {
    const { instanceUrl } = get();
    if (!instanceUrl) throw new Error('No Tavern instance is configured.');
    set({ status: 'checking', error: null });
    try {
      const response = await rawRequest<{ tokens: TokenPair }>(instanceUrl, '/auth/bootstrap', {
        method: 'POST',
        body: req,
        retryOn401: false,
      });
      await get().applyTokens(response.tokens);
      set({ needsBootstrap: false });
    } catch (err) {
      set({ status: 'unauthenticated', error: errorMessage(err, 'Setup failed.') });
      throw err;
    }
  },

  refresh: async () => {
    if (refreshInflight) return refreshInflight;
    refreshInflight = (async () => {
      const { instanceUrl, refreshToken } = get();
      if (!instanceUrl || !refreshToken) return false;
      try {
        const response = await rawRequest<{ tokens: TokenPair }>(instanceUrl, '/auth/refresh', {
          method: 'POST',
          body: { refreshToken },
          retryOn401: false,
        });
        await get().applyTokens(response.tokens);
        return true;
      } catch {
        await clearStoredTokens();
        set({
          status: 'unauthenticated',
          me: null,
          accessToken: null,
          accessTokenExpiresAt: null,
          refreshToken: null,
          stagedTotpToken: null,
        });
        return false;
      } finally {
        refreshInflight = null;
      }
    })();
    return refreshInflight;
  },

  logout: async () => {
    try {
      if (get().accessToken) {
        await get().api('/auth/logout', { method: 'POST', body: {} });
      }
    } catch {
      // Drop local state even if the network is gone.
    }
    await clearStoredTokens();
    set({
      status: 'unauthenticated',
      me: null,
      accessToken: null,
      accessTokenExpiresAt: null,
      refreshToken: null,
      stagedTotpToken: null,
    });
  },

  api: async <T>(path: string, opts: RequestOptions = {}) => {
    const { instanceUrl, accessToken } = get();
    if (!instanceUrl) throw new Error('No Tavern instance is configured.');
    try {
      return await rawRequest<T>(instanceUrl, path, { ...opts, accessToken });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && opts.retryOn401 !== false) {
        const refreshed = await get().refresh();
        if (refreshed) {
          return rawRequest<T>(instanceUrl, path, {
            ...opts,
            accessToken: get().accessToken,
            retryOn401: false,
          });
        }
      }
      throw err;
    }
  },

  clearError: () => set({ error: null }),

  applyTokens: async (tokens: TokenPair) => {
    await Promise.all([
      writeRefreshToken(tokens.refreshToken),
      writeAccessExpiry(tokens.accessTokenExpiresAt),
    ]);
    const { instanceUrl } = get();
    if (!instanceUrl) throw new Error('No Tavern instance is configured.');
    const me = await rawRequest<Me>(instanceUrl, '/auth/me', {
      accessToken: tokens.accessToken,
    });
    set({
      status: 'authenticated',
      me,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: tokens.refreshToken,
      stagedTotpToken: null,
      needsBootstrap: false,
      error: null,
    });
  },
}));

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
