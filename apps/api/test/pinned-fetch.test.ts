import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedIp, pinnedFetch } from '../src/lib/pinned-fetch.js';

describe('isBlockedIp', () => {
  describe('IPv4 — blocked', () => {
    it.each([
      // Loopback / private / link-local
      ['127.0.0.1'],
      ['127.255.255.255'],
      ['10.0.0.1'],
      ['10.255.255.255'],
      ['172.16.0.1'],
      ['172.31.255.255'],
      ['192.168.1.1'],
      ['192.168.255.255'],
      ['169.254.1.1'],
      // CGNAT
      ['100.64.0.1'],
      ['100.127.255.254'],
      // Reserved / multicast / "this network"
      ['0.0.0.0'],
      ['0.1.2.3'],
      ['224.0.0.1'],     // multicast
      ['239.255.255.250'], // SSDP
      ['240.0.0.0'],     // reserved
      ['255.255.255.255'], // broadcast
      // IETF documentation / test ranges
      ['192.0.2.1'],
      ['198.51.100.1'],
      ['203.0.113.1'],
      // RFC 2544 benchmark
      ['198.18.0.1'],
      ['198.19.255.255'],
    ])('blocks %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  });

  describe('IPv4 — allowed', () => {
    it.each([
      ['1.1.1.1'],         // Cloudflare DNS
      ['8.8.8.8'],         // Google DNS
      ['9.9.9.9'],         // Quad9
      ['151.101.1.1'],     // Fastly
      ['172.15.255.255'],  // just below RFC 1918 172.16/12 → public
      ['172.32.0.1'],      // just above RFC 1918 172.16/12 → public
      ['100.63.255.255'],  // just below CGNAT 100.64/10
      ['100.128.0.0'],     // just above CGNAT 100.64/10
      ['11.0.0.0'],        // just above 10/8
      ['191.255.255.255'], // just below 192.x
      ['198.20.0.0'],      // just above RFC 2544 198.18/15
      ['198.50.255.255'],  // just below TEST-NET-2
      ['223.255.255.255'], // just below multicast 224/4
    ])('allows %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  });

  describe('IPv6 — blocked', () => {
    it.each([
      ['::1'],                                    // loopback
      ['::'],                                     // unspecified
      ['::ffff:192.168.1.1'],                     // v4-mapped
      ['fc00::1'],                                // ULA
      ['fd12:3456:789a::1'],                      // ULA
      ['fe80::1'],                                // link-local
      ['febf:ffff:ffff:ffff::1'],                 // last link-local
      ['ff02::1'],                                // multicast
    ])('blocks %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  });

  describe('IPv6 — allowed', () => {
    it.each([
      ['2606:4700:4700::1111'], // Cloudflare DNS
      ['2001:4860:4860::8888'], // Google DNS
      ['2001:db8::1'],          // RFC 3849 doc range — public-shape; we allow
      // (a stricter helper could choose to also block 2001:db8/32, but
      // since it is unrouteable on the public Internet it would only ever
      // arrive via a hostile resolver, which DNS doesn't actually deliver)
    ])('allows %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  });

  it('refuses non-IP strings (fails-closed)', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
    expect(isBlockedIp('example.com')).toBe(true);
  });
});

describe('pinnedFetch', () => {
  // Reusable HTTP server bound to 127.0.0.1 for the "blocked IP" coverage.
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('refuses a bare-loopback URL', async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /blocked IP/,
    );
  });

  it('refuses an explicit IPv6 loopback URL', async () => {
    await expect(pinnedFetch(`http://[::1]:${port}/`)).rejects.toThrow(
      /blocked IP/,
    );
  });

  it('refuses a non-http(s) scheme', async () => {
    await expect(pinnedFetch('ftp://example.com/')).rejects.toThrow(
      /non-http\(s\) URL/,
    );
  });

  it('refuses a URL whose hostname resolves only to a blocked IP', async () => {
    // `localhost` resolves to 127.0.0.1 / ::1 — both blocked.
    await expect(pinnedFetch(`http://localhost:${port}/`)).rejects.toThrow(
      /blocked IP/,
    );
  });

  it('refuses an unresolvable hostname', async () => {
    // RFC 6761 — `.invalid` is guaranteed not to resolve.
    await expect(
      pinnedFetch('http://this-host-does-not-exist-tavern-test.invalid/'),
    ).rejects.toThrow(/no DNS results|dns/i);
  });

  it('respects an externally-supplied AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort(new Error('caller aborted'));
    await expect(
      pinnedFetch(`http://127.0.0.1:${port}/`, {
        init: { signal: ac.signal },
      }),
    ).rejects.toThrow();
  });
});
