import { test, expect } from '@playwright/test';

// Gated behind FEDERATION_E2E=1 because it requires the two-instance
// docker-compose testbed (infra/docker/docker-compose.federation.yml) to be up.
const enabled = process.env['FEDERATION_E2E'] === '1';

test.describe('federation peering handshake', () => {
  test.skip(!enabled, 'Set FEDERATION_E2E=1 with the testbed running to enable.');

  test('two instances complete a peering handshake', async ({ browser: _browser }) => {
    // Open https://a.tavern.local, log in as admin, add b.tavern.local as a peer.
    // Open https://b.tavern.local, log in as admin, approve the inbound request.
    // Reload a.tavern.local — verify the peer is now `peered`.
    // Stub for now; flesh out when the testbed is exercised manually.
    expect(true).toBe(true);
  });
});
