import type { ApiResponse } from '@tavern/shared/errors';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  accessToken?: string | null;
  retryOn401?: boolean;
}

export interface TavernInstanceInfo {
  name: string;
  version: string;
  features: {
    registrationOpen: boolean;
    trustSafetyCoreEnabled: boolean;
    unscannedUploadsAllowed: boolean;
    storageBackend: string;
    liveKitConfigured: boolean;
    scannerConfigured: boolean;
    redisConfigured: boolean;
    ssoEnabled: boolean;
    ssoButtonLabel?: string;
    aiRecapEnabled: boolean;
    federationEnabled: boolean;
  };
}

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

export function normalizeInstanceUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter a Tavern instance URL.');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Tavern URLs must start with http:// or https://.');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function buildGatewayUrl(instanceUrl: string): string {
  const url = new URL(instanceUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/gateway';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function rawRequest<T>(
  instanceUrl: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const endpoint = toApiPath(path);
  const url = new URL(endpoint, `${instanceUrl}/`);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  let parsed: ApiResponse<T> | null = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as ApiResponse<T>;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok || !parsed || parsed.ok === false) {
    if (parsed && parsed.ok === false) {
      throw new ApiError(parsed.error.code, parsed.error.message, res.status, parsed.error.details);
    }
    throw new ApiError('NETWORK_ERROR', `Request failed (${res.status})`, res.status);
  }

  return parsed.data;
}

function toApiPath(path: string): string {
  if (path.startsWith('/api/')) return path;
  if (path.startsWith('api/')) return `/${path}`;
  return `/api${path.startsWith('/') ? path : `/${path}`}`;
}
