/**
 * Unit tests for resolveQualifiedMentionsAsync in mentions-service.
 *
 * Verifies that:
 *  1. Text with no qualified mentions → fetchRemoteProfile is never called.
 *  2. Text with two distinct qualified mentions → fetchRemoteProfile called once per unique id.
 *  3. Text with the same qualified mention twice → fetchRemoteProfile called exactly once (dedup).
 *  4. A fetch failure does not throw (failure is swallowed).
 *  5. When federationProfile is null (federation disabled) → no-op.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveQualifiedMentionsAsync } from '../src/services/mentions-service.js';
import type { FederationProfileService } from '../src/services/federation-profile.js';

function makeMockService(
  impl?: () => Promise<unknown>,
): FederationProfileService {
  return {
    fetchRemoteProfile: vi.fn().mockImplementation(impl ?? (() => Promise.resolve())),
    respondToProfileRequest: vi.fn(),
    getCachedRemoteProfile: vi.fn(),
  } as unknown as FederationProfileService;
}

describe('resolveQualifiedMentionsAsync', () => {
  it('does nothing for text with no qualified mentions', () => {
    const service = makeMockService();
    resolveQualifiedMentionsAsync('Hello @alice and @here!', service);
    expect(service.fetchRemoteProfile).not.toHaveBeenCalled();
  });

  it('calls fetchRemoteProfile once per distinct qualified mention', async () => {
    const service = makeMockService();
    resolveQualifiedMentionsAsync(
      'Hey @alice@b.example and @bob@c.example, welcome!',
      service,
    );
    // Yield microtask queue so fire-and-forget Promises have a chance to start.
    await Promise.resolve();
    expect(service.fetchRemoteProfile).toHaveBeenCalledTimes(2);
    expect(service.fetchRemoteProfile).toHaveBeenCalledWith('alice@b.example');
    expect(service.fetchRemoteProfile).toHaveBeenCalledWith('bob@c.example');
  });

  it('deduplicates repeated mentions of the same remote user', async () => {
    const service = makeMockService();
    resolveQualifiedMentionsAsync(
      '@alice@b.example said hi to @alice@b.example',
      service,
    );
    await Promise.resolve();
    expect(service.fetchRemoteProfile).toHaveBeenCalledTimes(1);
    expect(service.fetchRemoteProfile).toHaveBeenCalledWith('alice@b.example');
  });

  it('swallows fetch errors and does not throw', async () => {
    const service = makeMockService(() => Promise.reject(new Error('peer unreachable')));
    const logger = { warn: vi.fn() };

    // Should not throw synchronously.
    expect(() => {
      resolveQualifiedMentionsAsync('@alice@b.example nice', service, logger);
    }).not.toThrow();

    // Allow the rejection to be handled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUserId: 'alice@b.example' }),
      'failed to resolve qualified mention',
    );
  });

  it('is a no-op when federationProfile is null', () => {
    // Must not throw even without a service.
    expect(() => {
      resolveQualifiedMentionsAsync('@alice@b.example hello', null);
    }).not.toThrow();
  });
});
