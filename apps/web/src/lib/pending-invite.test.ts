import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingInvite,
  readPendingInvite,
  savePendingInvite,
  shouldResumePendingInviteAfterRegistration,
} from './pending-invite.js';

function installSessionStorage(): Map<string, string> {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  return storage;
}

describe('pending invite handoff', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = installSessionStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recomputes the resume path instead of trusting sessionStorage', () => {
    storage.set(
      'tavern.pendingInvite',
      JSON.stringify({
        code: ' server-invite ',
        host: null,
        path: 'https://example.invalid/phish',
        createdAt: Date.now(),
      }),
    );

    expect(readPendingInvite()).toMatchObject({
      code: 'SERVER-INVITE',
      host: null,
      path: '/invites/SERVER-INVITE',
    });
  });

  it('does not require registration to revisit local invites after account creation', () => {
    savePendingInvite('local-code');
    const pending = readPendingInvite();

    expect(pending).not.toBeNull();
    expect(shouldResumePendingInviteAfterRegistration(pending!)).toBe(false);
  });

  it('requires registration to resume federated invites after account creation', () => {
    savePendingInvite('remote-code', 'b.example.test');
    const pending = readPendingInvite();

    expect(pending).not.toBeNull();
    expect(pending?.path).toBe('/invites/REMOTE-CODE?host=b.example.test');
    expect(shouldResumePendingInviteAfterRegistration(pending!)).toBe(true);
  });

  it('clears malformed pending invite values', () => {
    storage.set('tavern.pendingInvite', JSON.stringify({ code: '', createdAt: Number.NaN }));

    expect(readPendingInvite()).toBeNull();
    expect(storage.has('tavern.pendingInvite')).toBe(false);
    clearPendingInvite();
  });

  it('treats unavailable sessionStorage as a missing pending invite', () => {
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

    expect(() => savePendingInvite('blocked')).not.toThrow();
    expect(readPendingInvite()).toBeNull();
    expect(() => clearPendingInvite()).not.toThrow();
  });
});
