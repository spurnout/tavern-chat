import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from './api-client.js';

function tokenPair() {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshTokenExpiresAt: '2099-01-02T00:00:00.000Z',
  };
}

describe('tokenStore', () => {
  afterEach(() => {
    tokenStore.clear();
    vi.unstubAllGlobals();
  });

  it('keeps the in-memory access token when sessionStorage writes are unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });

    expect(() => tokenStore.set(tokenPair())).not.toThrow();
    expect(tokenStore.accessToken).toBe('access-token');
    expect(tokenStore.accessExpiresAt).toBeNull();
    expect(tokenStore.hasSessionHint).toBe(false);
    expect(() => tokenStore.clear()).not.toThrow();
  });
});
