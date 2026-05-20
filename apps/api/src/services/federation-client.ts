import { discoveryDocSchema, WELL_KNOWN_PATH, type DiscoveryDoc } from '@tavern/shared';

const DEFAULT_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function discoverInstance(host: string): Promise<DiscoveryDoc> {
  // Always https in production; testbed uses local CA so trust is wired
  // via NODE_EXTRA_CA_CERTS, see docker-compose.federation.yml.
  const url = `https://${host}${WELL_KNOWN_PATH}`;
  const res = await fetchWithTimeout(url, { method: 'GET' }, DEFAULT_TIMEOUT_MS);
  if (!res.ok) throw new Error(`discovery ${host}: HTTP ${res.status}`);
  const body = await res.json();
  return discoveryDocSchema.parse(body);
}

export interface PeeringPostResult {
  id: string;
}

export async function postPeeringEnvelope(
  peeringUrl: string,
  envelope: unknown,
): Promise<PeeringPostResult> {
  const attempt = async (): Promise<Response> =>
    fetchWithTimeout(
      peeringUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      },
      DEFAULT_TIMEOUT_MS,
    );
  let res = await attempt();
  if (!res.ok && res.status >= 500) {
    res = await attempt();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`peering POST: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as PeeringPostResult;
}

export async function postProfileEnvelope(
  profileUrl: string,
  envelope: unknown,
): Promise<unknown> {
  const attempt = async (): Promise<Response> =>
    fetchWithTimeout(
      profileUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      },
      DEFAULT_TIMEOUT_MS,
    );
  let res = await attempt();
  if (!res.ok && res.status >= 500) {
    res = await attempt();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`profile POST: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json();
}
