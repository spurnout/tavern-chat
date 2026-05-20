/**
 * Validates a peer hostname before any outbound discovery fetch. Prevents SSRF
 * via unauthenticated routes and defence-in-depth for admin-initiated paths.
 *
 * Rejects: bare IPs (IPv4/IPv6), localhost, hostnames without a dot.
 *
 * Throws a plain Error on invalid input. Callers in apps/api that want a
 * typed PeeringError wrap this call (see apps/api/src/services/federation-peering.ts).
 */
export function assertValidPeerHost(host: string): void {
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
}
