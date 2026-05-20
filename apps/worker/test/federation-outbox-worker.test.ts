/**
 * P3-5: Federation outbox worker — dispatcher-level unit tests.
 *
 * Covers the actual POST-to-peer behaviour against a real loopback HTTP
 * server. The BullMQ worker layer is a thin wrapper around dispatchOutboxJob,
 * so testing the dispatcher (with the same call shape the worker uses) covers
 * the behaviour the task spec asks for without needing a live Redis.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import {
  FederationKeyStore,
  FederationOutboxPermanentError,
  UserKeyStore,
  dispatchOutboxJob,
  generateKeyPair,
  exportPublicKeyRaw,
  exportPrivateKeyPkcs8,
  encryptAtRest,
} from '@tavern/federation';

const SELF_HOST = 'self.example';

interface ServerHandle {
  url: string;
  host: string; // hostname:port
  requests: Array<{ url: string; method: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<ServerHandle> {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ url: req.url ?? '', method: req.method ?? '', body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    host: `127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

// Build a minimally-realistic FederationKeyStore that signs without needing a DB.
// We provision the keypair manually and inject it via the same shape the class
// uses internally (via a prisma stub that returns a pre-populated row).
function makeStandaloneFederationKeys(dataKey: Buffer): FederationKeyStore {
  const kp = generateKeyPair();
  const publicKeyRaw = exportPublicKeyRaw(kp.publicKey);
  const pkcs8 = exportPrivateKeyPkcs8(kp.privateKey);
  const encrypted = encryptAtRest(pkcs8, dataKey);
  const fakePrisma = {
    federationKey: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'fk_test',
        isCurrent: true,
        publicKey: publicKeyRaw,
        privateKey: encrypted,
      }),
      create: vi.fn(),
    },
  } as unknown as PrismaClient;
  return new FederationKeyStore({ dataKey, prisma: fakePrisma });
}

// Likewise: user-keys store that returns one user with a pre-provisioned keypair.
function makeStandaloneUserKeys(dataKey: Buffer, userId: string): UserKeyStore {
  const kp = generateKeyPair();
  const publicRaw = exportPublicKeyRaw(kp.publicKey);
  const pkcs8 = exportPrivateKeyPkcs8(kp.privateKey);
  const encrypted = encryptAtRest(pkcs8, dataKey);
  const fakePrisma = {
    user: {
      findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id !== userId) return Promise.resolve(null);
        return Promise.resolve({
          federationKeyPublic: publicRaw,
          federationKeyPrivate: encrypted,
        });
      }),
      update: vi.fn(),
    },
  } as unknown as PrismaClient;
  return new UserKeyStore({ dataKey, prisma: fakePrisma });
}

interface PeerStub {
  id: string;
  host: string;
  status: string;
  // unused but present so prisma typings are happy
  instanceKey: Buffer;
  capabilities: string[];
  peeredAt: Date | null;
}

function makePrismaWithPeer(peer: PeerStub): PrismaClient {
  return {
    remoteInstance: {
      findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id !== peer.id) return Promise.resolve(null);
        return Promise.resolve(peer);
      }),
    },
  } as unknown as PrismaClient;
}

describe('federation outbox dispatcher', () => {
  let dataKey: Buffer;
  let userId: string;

  beforeEach(() => {
    dataKey = Buffer.alloc(32, 7);
    userId = 'usr_test_01';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: POSTs a two-layer envelope to https://<peer>/_federation/event', async () => {
    let captured: unknown = null;
    const server = await startServer((req, res) => {
      if (req.url === '/_federation/event') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404).end();
      }
    });
    try {
      // Peer host is a real-looking FQDN so the SSRF guard accepts it. The
      // fetchImpl override below redirects the actual network call to our
      // loopback test server.
      const peerHost = 'peer.test';
      const peer: PeerStub = {
        id: 'ri_peer_1',
        host: peerHost,
        status: 'peered',
        instanceKey: Buffer.alloc(32),
        capabilities: ['messages'],
        peeredAt: new Date(),
      };
      const prisma = makePrismaWithPeer(peer);
      const fedKeys = makeStandaloneFederationKeys(dataKey);
      await fedKeys.bootstrap();
      const userKeys = makeStandaloneUserKeys(dataKey, userId);

      // Override fetch to redirect https://<peer.test>/... to our http loopback.
      const fetchSpy = vi.fn().mockImplementation((url: string, init: RequestInit) => {
        captured = init.body ? JSON.parse(init.body as string) : null;
        const u = new URL(url);
        return fetch(`${server.url}${u.pathname}`, init);
      });

      await dispatchOutboxJob(
        {
          messageId: 'msg_1',
          peerInstanceId: peer.id,
          eventType: 'message.create',
          authorUserId: userId,
          payload: {
            authorRemoteUserId: `alice@${SELF_HOST}`,
            channelId: 'chan_1',
            messageId: 'msg_1',
            content: 'hello federation',
            createdAt: new Date().toISOString(),
          },
        },
        {
          prisma,
          federationKeys: fedKeys,
          userKeys,
          selfHost: SELF_HOST,
          fetchImpl: fetchSpy as unknown as typeof fetch,
        },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = (fetchSpy.mock.calls[0]?.[0] ?? '') as string;
      expect(calledUrl).toBe(`https://${peerHost}/_federation/event`);
      expect(server.requests).toHaveLength(1);
      const req = server.requests[0]!;
      expect(req.url).toBe('/_federation/event');
      expect(req.method).toBe('POST');
      // Envelope shape — two-layer means both userSignature and signature present.
      const env = req.body as Record<string, unknown>;
      expect(env['eventType']).toBe('message.create');
      expect(env['fromInstance']).toBe(SELF_HOST);
      expect(env['toInstance']).toBe(peerHost);
      expect(typeof env['userSignature']).toBe('string');
      expect(typeof env['signature']).toBe('string');
      expect(captured).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('skips dispatch when peer is no longer in peered state', async () => {
    const peer: PeerStub = {
      id: 'ri_peer_2',
      host: 'example.com',
      status: 'revoked',
      instanceKey: Buffer.alloc(32),
      capabilities: [],
      peeredAt: null,
    };
    const prisma = makePrismaWithPeer(peer);
    const fedKeys = makeStandaloneFederationKeys(dataKey);
    await fedKeys.bootstrap();
    const userKeys = makeStandaloneUserKeys(dataKey, userId);
    const fetchSpy = vi.fn();
    await dispatchOutboxJob(
      {
        messageId: 'msg_x',
        peerInstanceId: peer.id,
        eventType: 'message.create',
        authorUserId: userId,
        payload: { irrelevant: true },
      },
      {
        prisma,
        federationKeys: fedKeys,
        userKeys,
        selfHost: SELF_HOST,
        fetchImpl: fetchSpy as unknown as typeof fetch,
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws plain Error on 5xx — caller retries', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'try later' }));
    });
    try {
      const peerHost = 'peer-5xx.test';
      const peer: PeerStub = {
        id: 'ri_peer_3',
        host: peerHost,
        status: 'peered',
        instanceKey: Buffer.alloc(32),
        capabilities: [],
        peeredAt: new Date(),
      };
      const prisma = makePrismaWithPeer(peer);
      const fedKeys = makeStandaloneFederationKeys(dataKey);
      await fedKeys.bootstrap();
      const userKeys = makeStandaloneUserKeys(dataKey, userId);
      const fetchSpy = vi.fn().mockImplementation((url: string, init: RequestInit) => {
        const u = new URL(url);
        return fetch(`${server.url}${u.pathname}`, init);
      });

      let thrown: unknown;
      try {
        await dispatchOutboxJob(
          {
            messageId: 'msg_5xx',
            peerInstanceId: peer.id,
            eventType: 'message.create',
            authorUserId: userId,
            payload: { content: 'x' },
          },
          {
            prisma,
            federationKeys: fedKeys,
            userKeys,
            selfHost: SELF_HOST,
            fetchImpl: fetchSpy as unknown as typeof fetch,
          },
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(FederationOutboxPermanentError);
      expect((thrown as Error).message).toMatch(/503/);
    } finally {
      await server.close();
    }
  });

  it('throws FederationOutboxPermanentError on 4xx — caller does NOT retry', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed envelope' }));
    });
    try {
      const peerHost = 'peer-4xx.test';
      const peer: PeerStub = {
        id: 'ri_peer_4',
        host: peerHost,
        status: 'peered',
        instanceKey: Buffer.alloc(32),
        capabilities: [],
        peeredAt: new Date(),
      };
      const prisma = makePrismaWithPeer(peer);
      const fedKeys = makeStandaloneFederationKeys(dataKey);
      await fedKeys.bootstrap();
      const userKeys = makeStandaloneUserKeys(dataKey, userId);
      const fetchSpy = vi.fn().mockImplementation((url: string, init: RequestInit) => {
        const u = new URL(url);
        return fetch(`${server.url}${u.pathname}`, init);
      });
      let thrown: unknown;
      try {
        await dispatchOutboxJob(
          {
            messageId: 'msg_4xx',
            peerInstanceId: peer.id,
            eventType: 'message.create',
            authorUserId: userId,
            payload: { content: 'x' },
          },
          {
            prisma,
            federationKeys: fedKeys,
            userKeys,
            selfHost: SELF_HOST,
            fetchImpl: fetchSpy as unknown as typeof fetch,
          },
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FederationOutboxPermanentError);
      expect((thrown as FederationOutboxPermanentError).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('rejects via SSRF guard before any network when peer.host is an IP literal', async () => {
    const peer: PeerStub = {
      id: 'ri_peer_5',
      host: '127.0.0.1',
      status: 'peered',
      instanceKey: Buffer.alloc(32),
      capabilities: [],
      peeredAt: new Date(),
    };
    const prisma = makePrismaWithPeer(peer);
    const fedKeys = makeStandaloneFederationKeys(dataKey);
    await fedKeys.bootstrap();
    const userKeys = makeStandaloneUserKeys(dataKey, userId);
    const fetchSpy = vi.fn();
    await expect(
      dispatchOutboxJob(
        {
          messageId: 'msg_ssrf',
          peerInstanceId: peer.id,
          eventType: 'message.create',
          authorUserId: userId,
          payload: { content: 'x' },
        },
        {
          prisma,
          federationKeys: fedKeys,
          userKeys,
          selfHost: SELF_HOST,
          fetchImpl: fetchSpy as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/IPv4 address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
