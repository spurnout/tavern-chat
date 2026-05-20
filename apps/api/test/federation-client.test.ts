import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverInstance, postPeeringEnvelope } from '../src/services/federation-client.js';

describe('federation-client', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as never; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('fetches and zod-validates a discovery doc', async () => {
    (globalThis.fetch as never as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        instance: 'b.example',
        softwareVersion: 'tavern/0.0.0',
        protocolVersion: 'ir20/1',
        instanceKey: 'ed25519:AAAA',
        endpoints: {
          peering: 'https://b.example/_federation/peering',
          events: 'wss://b.example/_federation/events',
          backfill: 'https://b.example/_federation/backfill',
        },
        capabilities: ['messages'],
      }),
    });
    const doc = await discoverInstance('b.example');
    expect(doc.instance).toBe('b.example');
  });

  it('rejects a discovery response with the wrong protocolVersion', async () => {
    (globalThis.fetch as never as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ instance: 'b', softwareVersion: 'x', protocolVersion: 'ir99/1', instanceKey: 'ed25519:x', endpoints: { peering: 'https://b/p', events: 'wss://b/e', backfill: 'https://b/b' }, capabilities: [] }),
    });
    await expect(discoverInstance('b.example')).rejects.toThrow();
  });

  it('retries once on 5xx then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'down' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: 'log-1' }) });
    globalThis.fetch = f as never;
    const r = await postPeeringEnvelope('https://b.example/_federation/peering', { fake: 'env' } as never);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.id).toBe('log-1');
  });

  it('throws after the second 5xx', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' });
    globalThis.fetch = f as never;
    await expect(postPeeringEnvelope('https://b.example/_federation/peering', { fake: 'env' } as never)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
