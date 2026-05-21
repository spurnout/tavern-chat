import type { ApiResponse, FederatedInvitePreview, TokenPair } from '@tavern/shared';

const API_BASE = '/api';

/**
 * Token storage policy (SEC-001 / FE-02):
 *   - **Access token:** held in memory only. A page refresh forces a `/refresh`
 *     round-trip — the cost is a single HTTP call, and the win is that no
 *     script-readable storage ever holds a bearer credential.
 *   - **Refresh token:** delivered by the API as an httpOnly+Secure+SameSite=Strict
 *     cookie (`tv_refresh`). Not visible to JS at all; cannot be exfiltrated by
 *     XSS, cannot be sent on third-party navigations.
 *   - **Expiry timestamp:** kept in `sessionStorage` so we know when to refresh
 *     proactively. `sessionStorage` clears on tab close, matching the cookie's
 *     session semantics, and only holds a non-secret number — losing it just
 *     means we discover the expiry by failing a request.
 */
class TokenStore {
  private static ACCESS_EXP_KEY = 'tavern.access_exp';
  private memoryAccessToken: string | null = null;

  get accessToken(): string | null {
    return this.memoryAccessToken;
  }

  get accessExpiresAt(): number | null {
    if (typeof sessionStorage === 'undefined') return null;
    const v = sessionStorage.getItem(TokenStore.ACCESS_EXP_KEY);
    return v ? Number(v) : null;
  }

  /** True iff we believe we have a valid live session (subject to server confirmation). */
  get hasSessionHint(): boolean {
    const exp = this.accessExpiresAt;
    return exp !== null && exp > Date.now();
  }

  set(tokens: TokenPair): void {
    this.memoryAccessToken = tokens.accessToken;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(
        TokenStore.ACCESS_EXP_KEY,
        String(new Date(tokens.accessTokenExpiresAt).getTime()),
      );
    }
  }

  clear(): void {
    this.memoryAccessToken = null;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(TokenStore.ACCESS_EXP_KEY);
    }
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
    // Refresh token is delivered as an httpOnly cookie scoped to /api/auth.
    // 'include' is required for that cookie to ride along with /auth/refresh
    // requests; the strict CORS allowlist in apps/api/src/app.ts gates which
    // origins this is honoured for.
    credentials: 'include',
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
  refreshInflight = (async () => {
    try {
      // The refresh token rides along as the tv_refresh httpOnly cookie —
      // there's no body to send. If the cookie is missing or expired the
      // API returns 401, which we convert to a clean clear-state below.
      const res = await rawRequest<{ tokens: TokenPair }>(`/auth/refresh`, {
        method: 'POST',
        body: {},
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

// --- Federation Phase 4 / P4-16 ----------------------------------------------
//
// Three thin wrappers over the federated invite + mirror flows. They live on
// the api-client (rather than a feature module) so the existing rawRequest /
// retry-on-401 / token refresh plumbing applies for free.

/**
 * Fetch a preview of a federated invite by proxying through OUR API to the
 * peer's preview endpoint. The SPA can't call the peer directly (CORS, IP
 * leak, and the X-Tavern-Federation-Caller-* headers can only be set
 * truthfully server-side). On success: the standard preview DTO. On peer
 * error: the API forwards the upstream code (NOT_FOUND / INVALID_INVITE /
 * PERMISSION_DENIED), so the caller can switch on `ApiError.code`.
 */
export async function previewFederatedInvite(
  host: string,
  code: string,
): Promise<FederatedInvitePreview> {
  return api<FederatedInvitePreview>('/federation/invite-preview', {
    method: 'GET',
    query: { host, code },
  });
}

/**
 * Redeem a federated invite. POSTs a signed member.join_request to the home
 * via the API, which mirrors the snapshot the home returns. On success the
 * gateway broadcasts SERVER_ADD to the joiner, but the resolved `serverId` is
 * also returned here so the caller can navigate immediately without waiting
 * for the WS round-trip.
 */
export async function acceptFederatedInvite(
  code: string,
  host: string,
): Promise<{ serverId: string; mirrored: boolean; alreadyMember: boolean }> {
  return api<{ serverId: string; mirrored: boolean; alreadyMember: boolean }>(
    `/federation/invites/${encodeURIComponent(code)}/accept`,
    {
      method: 'POST',
      body: { remoteInstanceHost: host },
    },
  );
}

/**
 * Leave a federated mirror den. Synchronously round-trips a member.leave to
 * the home and only mutates local state once the home acks. The caller is
 * expected to navigate away from the mirror's routes immediately afterwards
 * (the gateway will broadcast SERVER_REMOVE on the next tick when the mirror
 * is torn down).
 */
export async function leaveMirrorServer(
  serverId: string,
): Promise<{ serverId: string; mirrorTornDown: boolean }> {
  return api<{ serverId: string; mirrorTornDown: boolean }>(
    `/federation/mirror-servers/${encodeURIComponent(serverId)}/leave`,
    { method: 'POST', body: {} },
  );
}
