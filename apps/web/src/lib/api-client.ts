import type { ApiResponse, TokenPair } from '@tavern/shared';

const API_BASE = '/api';

class TokenStore {
  private static ACCESS = 'tavern.access';
  private static REFRESH = 'tavern.refresh';
  private static ACCESS_EXP = 'tavern.access_exp';

  get accessToken(): string | null {
    return localStorage.getItem(TokenStore.ACCESS);
  }

  get refreshToken(): string | null {
    return localStorage.getItem(TokenStore.REFRESH);
  }

  get accessExpiresAt(): number | null {
    const v = localStorage.getItem(TokenStore.ACCESS_EXP);
    return v ? Number(v) : null;
  }

  set(tokens: TokenPair): void {
    localStorage.setItem(TokenStore.ACCESS, tokens.accessToken);
    localStorage.setItem(TokenStore.REFRESH, tokens.refreshToken);
    localStorage.setItem(
      TokenStore.ACCESS_EXP,
      String(new Date(tokens.accessTokenExpiresAt).getTime()),
    );
  }

  clear(): void {
    localStorage.removeItem(TokenStore.ACCESS);
    localStorage.removeItem(TokenStore.REFRESH);
    localStorage.removeItem(TokenStore.ACCESS_EXP);
  }
}

export const tokenStore = new TokenStore();

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** When false, skip the auto-refresh-on-401 cycle. */
  retryOn401?: boolean;
}

async function rawRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(API_BASE + path, window.location.origin);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const access = tokenStore.accessToken;
  if (access) headers.authorization = `Bearer ${access}`;

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: 'omit',
  });

  let body: ApiResponse<T> | null = null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    /* fall through to status-based error */
  }

  if (!res.ok || !body || body.ok === false) {
    if (body && body.ok === false) {
      throw new ApiError(body.error.code, body.error.message, res.status, body.error.details);
    }
    throw new ApiError('NETWORK_ERROR', `Request failed (${res.status})`, res.status);
  }

  return body.data;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(path, opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && opts.retryOn401 !== false) {
      const refreshed = await tryRefresh();
      if (refreshed) return rawRequest<T>(path, { ...opts, retryOn401: false });
    }
    throw err;
  }
}

let refreshInflight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  const refreshToken = tokenStore.refreshToken;
  if (!refreshToken) return false;
  refreshInflight = (async () => {
    try {
      const res = await rawRequest<{ tokens: TokenPair }>(`/auth/refresh`, {
        method: 'POST',
        body: { refreshToken },
        retryOn401: false,
      });
      tokenStore.set(res.tokens);
      return true;
    } catch {
      tokenStore.clear();
      return false;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}
