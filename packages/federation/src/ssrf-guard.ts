import { promises as dns } from 'node:dns';

const PRIVATE_IP_PATTERNS = [
  /^127\./,                            // loopback
  /^10\./,                             // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,       // RFC 1918
  /^192\.168\./,                       // RFC 1918
  /^169\.254\./,                       // link-local
  /^::1$/,                             // IPv6 loopback
  /^f[cd][0-9a-f]{2}:/i,               // fc00::/7 unique-local (fc** and fd**)
  /^fe[89ab][0-9a-f]:/i,               // fe80::/10 link-local
];

const DNS_TIMEOUT_MS = 3_000;

function dnsWithTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS),
    ),
  ]);
}

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((re) => re.test(ip));
}

/**
 * Validates a peer hostname before any outbound discovery fetch. Prevents SSRF
 * via unauthenticated routes and defence-in-depth for admin-initiated paths.
 *
 * Rejects: bare IPs (IPv4/IPv6), localhost, hostnames without a dot,
 * and hostnames that resolve exclusively to private/loopback addresses.
 *
 * DNS resolution is best-effort — NXDOMAIN / network errors allow through
 * (the subsequent fetch will fail naturally at connection time). Only rejects
 * when ALL resolved addresses are private/loopback.
 *
 * Throws a plain Error on invalid input. Callers in apps/api that want a
 * typed PeeringError wrap this call (see apps/api/src/services/federation-peering.ts).
 */
export async function assertValidPeerHost(host: string): Promise<void> {
  if (!host || typeof host !== 'string') {
    throw new Error('peer host is required');
  }
  const lower = host.toLowerCase();
  if (lower === 'localhost') {
    throw new Error('peer host cannot be localhost');
  }
  // Bare IPv4: digits, dots, nothing else
  if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(host)) {
    throw new Error('peer host must be a hostname, not an IPv4 address');
  }
  // IPv6: contains colon (a hostname:port shape would also match, but real
  // peer hosts don't carry a port in the discovery identifier)
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    throw new Error('peer host must not contain port or IPv6 brackets');
  }
  // Must contain at least one dot — rejects TLD-less names like "intranet"
  if (!host.includes('.')) {
    throw new Error('peer host must be a fully-qualified domain');
  }
  // Reject mDNS / loopback special-use suffixes. `*.local` (RFC 6762 mDNS) and
  // `*.localhost` (RFC 6761) name link-local / loopback hosts that must never be
  // federation peers. Crucially, public resolvers return NXDOMAIN for these, so
  // without this synchronous check they would slip past the DNS guard below
  // (NXDOMAIN allows through) and reach an internal host on the LAN.
  if (lower.endsWith('.local') || lower.endsWith('.localhost')) {
    throw new Error('peer host cannot be an mDNS/loopback (.local/.localhost) name');
  }

  // DNS resolution (best-effort — NXDOMAIN / network errors allow through,
  // letting the fetch fail naturally at connection time).
  try {
    const [v4, v6] = await Promise.allSettled([
      dnsWithTimeout(dns.resolve4(host)),
      dnsWithTimeout(dns.resolve6(host)),
    ]);
    const ips = [
      ...(v4.status === 'fulfilled' ? v4.value : []),
      ...(v6.status === 'fulfilled' ? v6.value : []),
    ];
    if (ips.length > 0 && ips.every(isPrivateIp)) {
      throw new Error(`peer host ${host} resolves only to private/loopback addresses`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('peer host')) throw err;
    // DNS unavailable / NXDOMAIN — let fetch fail naturally
  }
}
