import { create } from 'zustand';
import type {
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
  bootstrap: () => Promise<void>;
  login: (req: LoginRequest) => Promise<void>;
  register: (req: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
}

async function fetchMe(): Promise<Me> {
  return api<Me>('/auth/me');
}

export const useAuth = create<AuthState>((set) => ({
  me: null,
  status: 'idle',
  error: null,

  bootstrap: async () => {
    if (!tokenStore.accessToken && !tokenStore.refreshToken) {
      set({ status: 'unauthenticated' });
      return;
    }
    set({ status: 'loading', error: null });
    try {
      const me = await fetchMe();
      set({ me, status: 'authenticated', error: null });
    } catch (err) {
      tokenStore.clear();
      const msg = err instanceof ApiError ? err.message : 'Could not load profile';
      set({ me: null, status: 'unauthenticated', error: msg });
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
      set({ me, status: 'authenticated', error: null });
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
      set({ me, status: 'authenticated', error: null });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Registration failed';
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
    set({ me: null, status: 'unauthenticated', error: null });
  },
}));
