/**
 * Characterization tests for `assertValidPeerHost` — the SSRF guard run before
 * any outbound federation discovery fetch.
 *
 * Two layers are covered:
 *  1. Synchronous structural rejections (no DNS needed) — empty/non-string
 *     input, localhost, bare IPv4 (+ port), strings carrying ':'/'['/']',
 *     and dot-less hostnames.
 *  2. DNS resolution branches via a mocked `node:dns` — a host resolving only
 *     to private/loopback addresses REJECTS; one resolving to a public address
 *     RESOLVES; DNS failure / NXDOMAIN ALLOWS through (best-effort).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// The module under test imports `{ promises as dns } from 'node:dns'` and only
// ever calls dns.resolve4 / dns.resolve6, so a minimal mock suffices.
vi.mock('node:dns', () => ({
  promises: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

// Import the mocked dns AFTER vi.mock so we get the stubbed functions, and the
// guard AFTER as well so it binds to the mock.
import { promises as dns } from 'node:dns';
import { assertValidPeerHost } from './ssrf-guard.js';

const resolve4 = dns.resolve4 as unknown as ReturnType<typeof vi.fn>;
const resolve6 = dns.resolve6 as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Safe default: most synchronous-rejection tests never reach DNS, but if a
  // test does, default both lookups to NXDOMAIN-style rejection (allow-through).
  resolve4.mockRejectedValue(new Error('ENOTFOUND'));
  resolve6.mockRejectedValue(new Error('ENOTFOUND'));
});

describe('assertValidPeerHost — synchronous rejections (no DNS)', () => {
  it('rejects an empty string', async () => {
    await expect(assertValidPeerHost('')).rejects.toThrow(/required/i);
  });

  it('rejects a non-string host', async () => {
    // The guard explicitly checks `typeof host !== 'string'`.
    await expect(
      assertValidPeerHost(undefined as unknown as string),
    ).rejects.toThrow(/required/i);
    await expect(
      assertValidPeerHost(null as unknown as string),
    ).rejects.toThrow(/required/i);
    await expect(
      assertValidPeerHost(123 as unknown as string),
    ).rejects.toThrow(/required/i);
  });

  it('rejects literal "localhost"', async () => {
    await expect(assertValidPeerHost('localhost')).rejects.toThrow(/localhost/i);
  });

  it('rejects "localhost" regardless of case', async () => {
    await expect(assertValidPeerHost('LOCALHOST')).rejects.toThrow(/localhost/i);
    await expect(assertValidPeerHost('LocalHost')).rejects.toThrow(/localhost/i);
  });

  it('rejects a bare IPv4 address', async () => {
    await expect(assertValidPeerHost('10.0.0.1')).rejects.toThrow(
      /must be a hostname/i,
    );
    await expect(assertValidPeerHost('192.168.1.1')).rejects.toThrow(
      /must be a hostname/i,
    );
    await expect(assertValidPeerHost('93.184.216.34')).rejects.toThrow(
      /must be a hostname/i,
    );
  });

  it('rejects a bare IPv4 address with a port', async () => {
    await expect(assertValidPeerHost('192.168.1.1:8080')).rejects.toThrow(
      /must be a hostname/i,
    );
  });

  it('rejects a host containing a colon (IPv6 / port)', async () => {
    // A hostname with a port — not IPv4-shaped, so it falls to the colon check.
    await expect(assertValidPeerHost('peer.example.com:443')).rejects.toThrow(
      /port or IPv6 brackets/i,
    );
  });

  it('rejects a bare IPv6 address (contains colons)', async () => {
    await expect(assertValidPeerHost('::1')).rejects.toThrow(
      /port or IPv6 brackets/i,
    );
    await expect(assertValidPeerHost('fe80::1')).rejects.toThrow(
      /port or IPv6 brackets/i,
    );
  });

  it('rejects a bracketed IPv6 host', async () => {
    await expect(
      assertValidPeerHost('[2001:db8::1]'),
    ).rejects.toThrow(/port or IPv6 brackets/i);
  });

  it('rejects a host with only an opening or closing bracket', async () => {
    await expect(assertValidPeerHost('foo[bar')).rejects.toThrow(
      /port or IPv6 brackets/i,
    );
    await expect(assertValidPeerHost('foo]bar')).rejects.toThrow(
      /port or IPv6 brackets/i,
    );
  });

  it('rejects a dot-less hostname', async () => {
    await expect(assertValidPeerHost('intranet')).rejects.toThrow(
      /fully-qualified domain/i,
    );
  });

  it('rejects an mDNS .local hostname (RFC 6762)', async () => {
    await expect(assertValidPeerHost('printer.local')).rejects.toThrow(/\.local/i);
    await expect(assertValidPeerHost('My-NAS.LOCAL')).rejects.toThrow(/\.local/i);
    await expect(assertValidPeerHost('host.sub.local')).rejects.toThrow(/\.local/i);
  });

  it('rejects a .localhost loopback hostname (RFC 6761)', async () => {
    await expect(assertValidPeerHost('app.localhost')).rejects.toThrow(/localhost/i);
  });

  it('still allows a real domain that merely contains "local" mid-label', async () => {
    // `foo.local.example.com` ends with .com — it is NOT an mDNS name.
    resolve4.mockResolvedValue(['93.184.216.34']);
    resolve6.mockResolvedValue([]);
    await expect(
      assertValidPeerHost('foo.local.example.com'),
    ).resolves.toBeUndefined();
  });

  it('does not consult DNS for synchronously-rejected hosts', async () => {
    await expect(assertValidPeerHost('localhost')).rejects.toThrow();
    await expect(assertValidPeerHost('10.0.0.1')).rejects.toThrow();
    await expect(assertValidPeerHost('intranet')).rejects.toThrow();
    await expect(assertValidPeerHost('printer.local')).rejects.toThrow();
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });
});

describe('assertValidPeerHost — DNS resolution branches', () => {
  it('rejects a host resolving ONLY to private/loopback IPs', async () => {
    resolve4.mockResolvedValue(['10.0.0.5']);
    resolve6.mockResolvedValue([]);
    await expect(assertValidPeerHost('internal.example.com')).rejects.toThrow(
      /resolves only to private\/loopback/i,
    );
  });

  it('rejects when every resolved address (v4 + v6) is private/loopback', async () => {
    resolve4.mockResolvedValue(['127.0.0.1', '192.168.0.2', '169.254.1.1']);
    resolve6.mockResolvedValue(['::1', 'fd00::1', 'fe80::abcd']);
    await expect(assertValidPeerHost('all-private.example.com')).rejects.toThrow(
      /resolves only to private\/loopback/i,
    );
  });

  it('resolves (no throw) when at least one address is PUBLIC', async () => {
    resolve4.mockResolvedValue(['93.184.216.34']);
    resolve6.mockResolvedValue([]);
    await expect(
      assertValidPeerHost('peer.example.com'),
    ).resolves.toBeUndefined();
  });

  it('resolves when a public IPv4 sits alongside private addresses (not ALL private)', async () => {
    // `ips.every(isPrivateIp)` is false because one address is public.
    resolve4.mockResolvedValue(['10.0.0.5', '93.184.216.34']);
    resolve6.mockResolvedValue(['fd00::1']);
    await expect(
      assertValidPeerHost('mixed.example.com'),
    ).resolves.toBeUndefined();
  });

  it('resolves when only an IPv6 public address is returned', async () => {
    resolve4.mockResolvedValue([]);
    resolve6.mockResolvedValue(['2001:db8::1']);
    await expect(
      assertValidPeerHost('v6.example.com'),
    ).resolves.toBeUndefined();
  });

  it('allows through when BOTH lookups reject (NXDOMAIN / network error)', async () => {
    resolve4.mockRejectedValue(new Error('ENOTFOUND'));
    resolve6.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertValidPeerHost('does-not-resolve.example.com'),
    ).resolves.toBeUndefined();
  });

  it('allows through when both lookups return no addresses at all', async () => {
    // ips.length === 0 → the private-only guard is skipped → allow through.
    resolve4.mockResolvedValue([]);
    resolve6.mockResolvedValue([]);
    await expect(
      assertValidPeerHost('empty.example.com'),
    ).resolves.toBeUndefined();
  });

  it('allows through when one lookup rejects and the other returns a public IP', async () => {
    resolve4.mockResolvedValue(['93.184.216.34']);
    resolve6.mockRejectedValue(new Error('ENODATA'));
    await expect(
      assertValidPeerHost('partial.example.com'),
    ).resolves.toBeUndefined();
  });

  it('calls both resolve4 and resolve6 for a structurally valid host', async () => {
    resolve4.mockResolvedValue(['93.184.216.34']);
    resolve6.mockResolvedValue([]);
    await assertValidPeerHost('peer.example.com');
    expect(resolve4).toHaveBeenCalledWith('peer.example.com');
    expect(resolve6).toHaveBeenCalledWith('peer.example.com');
  });
});
