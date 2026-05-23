/**
 * `pinnedFetch` — a `fetch`-shaped wrapper that closes the DNS-rebinding
 * TOCTOU in the federation/SSRF guard pipeline.
 *
 * The existing `assertValidPeerHost` resolves a hostname once and refuses if
 * every resolved IP is private/loopback. The subsequent `fetch` then resolves
 * the hostname AGAIN at connect time — a hostile DNS server can return
 * different results for the second query (a public IP first, a private IP
 * second), letting an attacker tunnel a request to an internal service via
 * a hostname the operator nominally trusts.
 *
 * This helper closes that window:
 *
 *   1. Resolve the hostname ourselves (resolve4 + resolve6, in parallel).
 *   2. Refuse if ANY resolved IP is in the private/loopback/multicast/etc.
 *      block. The base `assertValidPeerHost` allowed through when "not all
 *      private" (defensive about CDNs returning mixed IPv4/IPv6); this
 *      stricter rule is what we want for paths whose request body / response
 *      will be reflected to the user.
 *   3. Pin the chosen IP into an `undici.Agent` that overrides the connect
 *      step to dial that IP directly while still setting `servername` and
 *      `Host` to the original hostname (so HTTPS handshake + Host-based
 *      vhosts keep working).
 *
 * Cost: one extra DNS resolution and one tiny Agent allocation per request.
 * Callers should NOT enable `redirect: 'follow'` — a 30x to a different
 * hostname must be re-validated by the caller (link-preview and OIDC both
 * do this with their own hop loops).
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const DNS_TIMEOUT_MS = 3_000;

const PRIVATE_V4_PATTERNS: ReadonlyArray<RegExp> = [
  /^0\./,                              // current network ("this" — 0.0.0.0/8)
  /^10\./,                             // RFC 1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^127\./,                            // loopback
  /^169\.254\./,                       // link-local
  /^172\.(1[6-9]|2\d|3[01])\./,        // RFC 1918
  /^192\.0\.0\./,                      // IETF reserved
  /^192\.0\.2\./,                      // TEST-NET-1
  /^192\.168\./,                       // RFC 1918
  /^198\.(1[89])\./,                   // RFC 2544 benchmark
  /^198\.51\.100\./,                   // TEST-NET-2
  /^203\.0\.113\./,                    // TEST-NET-3
  /^22[4-9]\./,                        // multicast 224/4 (224.x..239.x)
  /^23\d\./,                           // multicast continued (230..239)
  /^2[4-5]\d\./,                       // reserved 240/4 (240..255)
];

const PRIVATE_V6_PATTERNS: ReadonlyArray<RegExp> = [
  /^::1$/,                             // loopback
  /^::$/,                              // unspecified
  /^::ffff:/i,                         // v4-mapped — we already filtered v4
  /^fc[0-9a-f]{2}:/i,                  // fc00::/7 ULA
  /^fd[0-9a-f]{2}:/i,                  // fd00::/8 ULA
  /^fe[89ab][0-9a-f]:/i,               // fe80::/10 link-local
  /^ff[0-9a-f]{2}:/i,                  // ff00::/8 multicast
];

/**
 * True when `ip` is a string in the RFC 1918 / loopback / reserved /
 * multicast / link-local space. Falls back to false on input we don't
 * recognise so a future v6 form doesn't silently approve.
 */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return PRIVATE_V4_PATTERNS.some((re) => re.test(ip));
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return PRIVATE_V6_PATTERNS.some((re) => re.test(lower));
  }
  // Unknown shape — refuse rather than let it through.
  return true;
}

function dnsWithTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS),
    ),
  ]);
}

interface ResolvedHost {
  hostname: string;
  /** First non-blocked IP — what we'll dial. */
  ip: string;
  /** Address family of that IP (4 or 6). */
  family: 4 | 6;
}

async function resolveAndPin(hostname: string): Promise<ResolvedHost> {
  // `URL.hostname` returns IPv6 addresses still wrapped in brackets
  // (`[::1]`), whereas `net.isIP` / `dns.resolve*` expect the bare form.
  // Strip them here so the IP-shortcut branch fires for v6 too.
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Bare-IP URLs skip DNS but still go through the block check below.
  const direct = net.isIP(unbracketed);
  if (direct === 4 || direct === 6) {
    if (isBlockedIp(unbracketed)) {
      throw new Error(`pinned-fetch: host ${unbracketed} is a blocked IP`);
    }
    return { hostname: unbracketed, ip: unbracketed, family: direct };
  }

  // `localhost` is a host *name* not an IP — `dns.resolve*` doesn't consult
  // the system hosts file, so it would otherwise fall through as
  // "unresolvable" with a misleading error. Treat it as explicitly blocked.
  if (unbracketed.toLowerCase() === 'localhost') {
    throw new Error('pinned-fetch: host localhost resolves to a blocked IP');
  }

  const [v4, v6] = await Promise.allSettled([
    dnsWithTimeout(dns.resolve4(unbracketed)),
    dnsWithTimeout(dns.resolve6(unbracketed)),
  ]);
  const v4ips = v4.status === 'fulfilled' ? v4.value : [];
  const v6ips = v6.status === 'fulfilled' ? v6.value : [];
  const all = [...v4ips, ...v6ips];
  if (all.length === 0) {
    throw new Error(`pinned-fetch: no DNS results for ${unbracketed}`);
  }
  // Stricter than `assertValidPeerHost`: ANY blocked IP poisons the result.
  // A CDN that legitimately mixes public + internal records is not who we
  // want to let through on the SSRF-sensitive paths.
  for (const ip of all) {
    if (isBlockedIp(ip)) {
      throw new Error(
        `pinned-fetch: ${unbracketed} resolved to a blocked IP (${ip})`,
      );
    }
  }
  const ip = v4ips[0] ?? v6ips[0];
  if (!ip) throw new Error(`pinned-fetch: no usable IP for ${unbracketed}`);
  return { hostname: unbracketed, ip, family: net.isIP(ip) as 4 | 6 };
}

export interface PinnedFetchOptions {
  /** Per-request timeout including DNS + connect + headers + body. */
  timeoutMs?: number;
  /** Headers / method / body / signal forwarded to undici's fetch. */
  init?: Parameters<typeof undiciFetch>[1];
}

/**
 * Like `fetch(url)` but with the DNS-rebinding mitigation described in the
 * file docstring. Throws on a blocked / unresolvable / timed-out host. Never
 * follows redirects — the caller must inspect the response status and
 * recurse via this helper if it wants to chase a 30x.
 */
export async function pinnedFetch(
  url: string,
  opts: PinnedFetchOptions = {},
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`pinned-fetch: refused non-http(s) URL ${url}`);
  }
  const resolved = await resolveAndPin(parsed.hostname);

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ac = new AbortController();
  const externalSignal = opts.init?.signal as AbortSignal | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', () => ac.abort(externalSignal.reason));
  }
  const timer = setTimeout(() => ac.abort(new Error('pinned-fetch: timeout')), timeoutMs);

  // Custom Agent: override the DNS lookup so undici dials the pinned IP no
  // matter what hostname the URL parses to. `servername` controls SNI for
  // HTTPS, and the outgoing `Host` header is set by undici from the URL —
  // so the server still sees the original hostname for vhost routing while
  // we get a guarantee that the socket lands on the resolved IP.
  const agent = new Agent({
    connect: {
      servername: resolved.hostname,
      lookup: (_hostname, _options, cb) => {
        cb(null, resolved.ip, resolved.family);
      },
    },
  });

  try {
    // undici's fetch returns the standard global Response so callers can
    // chain .json() / .text() exactly as with native fetch.
    const res = await undiciFetch(url, {
      ...opts.init,
      signal: ac.signal,
      dispatcher: agent,
      // Manual: caller decides whether to chase 30x.
      redirect: 'manual',
    });
    return res as unknown as Response;
  } finally {
    clearTimeout(timer);
    // undici's Agent keeps a socket pool. Closing it eagerly costs the
    // would-be reuse but keeps memory bounded per call — these helpers
    // fire occasionally, so trading reuse for memory hygiene is right.
    await agent.close().catch(() => undefined);
  }
}
