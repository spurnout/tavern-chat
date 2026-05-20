import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import {
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSign,
} from '../src/lib/ed25519.js';
import { buildSignedEnvelope } from '../src/services/federation-envelopes.js';
import * as fc from '../src/services/federation-client.js';
import { FederationProfileService } from '../src/services/federation-profile.js';
import type { FederationKeyStore } from '../src/services/federation-keys.js';
import { ulid } from '@tavern/shared';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

// Keypair for this instance (a.example) — used to sign outbound request envelopes.
const selfKp = generateKeyPair();
const selfHost = 'a.example';

// Keypair for the remote peer (b.example) — used to sign response envelopes.
const peerKp = generateKeyPair();
const peerHost = 'b.example';

/** Build a mock discovery doc for b.example, signed by peerKp. */
function makePeerDiscovery() {
  return {
    instance: peerHost,
    softwareVersion: 'tavern/0.0.0',
    protocolVersion: 'ir20/1',
    instanceKey: `ed25519:${exportPublicKeyRaw(peerKp.publicKey).toString('base64')}`,
    endpoints: {
      peering: `https://${peerHost}/_federation/peering`,
      events: `wss://${peerHost}/_federation/events`,
      backfill: `https://${peerHost}/_federation/backfill`,
    },
    capabilities: ['messages'],
  };
}

/** Build a signed profile.response envelope as if b.example is responding. */
function makePeerProfileResponse(opts: {
  localpart: string;
  displayName: string;
  avatarUrl?: string | null;
  signingKey?: ReturnType<typeof generateKeyPair>;
}) {
  const kp = opts.signingKey ?? peerKp;
  const remoteUserId = `${opts.localpart}@${peerHost}`;
  const publicKeyB64 = exportPublicKeyRaw(kp.publicKey).toString('base64');
  return buildSignedEnvelope({
    eventType: 'profile.response',
    fromInstance: peerHost,
    toInstance: selfHost,
    payload: {
      remoteUserId,
      displayName: opts.displayName,
      avatarUrl: opts.avatarUrl ?? null,
      publicKey: `ed25519:${publicKeyB64}`,
    },
    sign: (bytes) => edSign(bytes, kp.privateKey),
  });
}

/** Create a FederationProfileService that uses the shared prisma client and selfKp. */
function makeService() {
  // Inline stub — avoids needing TAVERN_DATA_KEY in the test process.
  const keys = {
    sign: (bytes: Buffer) => edSign(bytes, selfKp.privateKey),
    getPublicKeyRaw: () => exportPublicKeyRaw(selfKp.publicKey),
    getPublicKeyAdvertised: () => `ed25519:${exportPublicKeyRaw(selfKp.publicKey).toString('base64')}`,
    bootstrap: () => Promise.resolve(),
  } as unknown as FederationKeyStore;

  return new FederationProfileService({
    keys,
    userKeys: {
      ensureKeyFor: () => Promise.resolve(),
      getPublicKeyRaw: () => Promise.resolve(null),
    } as never,
    selfHost,
    prisma,
  });
}

describe.skipIf(!dockerOk)('federation profile client — fetchRemoteProfile / getCachedRemoteProfile', () => {
  let remoteInstanceId: string;

  beforeEach(async () => {
    await prisma.remoteUser.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    vi.restoreAllMocks();

    // Seed a peered RemoteInstance for b.example.
    remoteInstanceId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteInstanceId,
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });
  });

  // ─── 1. Cache hit ─────────────────────────────────────────────────────────

  it('returns cached data without network when lastSeenAt is fresh', async () => {
    const remoteUserId = `bob@${peerHost}`;
    const userPublicKey = randomBytes(32);
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId,
        remoteUserId,
        displayNameCache: 'Bob',
        avatarUrlCache: null,
        publicKey: userPublicKey,
        lastSeenAt: new Date(), // fresh
      },
    });

    const discoverSpy = vi.spyOn(fc, 'discoverInstance');
    const postSpy = vi.spyOn(fc, 'postProfileEnvelope');

    const svc = makeService();
    const result = await svc.fetchRemoteProfile(remoteUserId);

    expect(discoverSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(result.displayNameCache).toBe('Bob');
    expect(result.remoteUserId).toBe(remoteUserId);
    expect(result.publicKey).toBeInstanceOf(Buffer);
    expect(result.publicKey.equals(userPublicKey)).toBe(true);
  });

  // ─── 2. Cache miss ────────────────────────────────────────────────────────

  it('fetches from remote and upserts RemoteUser on cache miss', async () => {
    const localpart = 'carol';
    const remoteUserId = `${localpart}@${peerHost}`;

    vi.spyOn(fc, 'discoverInstance').mockResolvedValue(makePeerDiscovery());
    const response = makePeerProfileResponse({ localpart, displayName: 'Carol' });
    vi.spyOn(fc, 'postProfileEnvelope').mockResolvedValue(response);

    const svc = makeService();
    const result = await svc.fetchRemoteProfile(remoteUserId);

    expect(fc.discoverInstance).toHaveBeenCalledWith(peerHost);
    expect(fc.postProfileEnvelope).toHaveBeenCalledOnce();
    expect(result.displayNameCache).toBe('Carol');
    expect(result.remoteUserId).toBe(remoteUserId);
    expect(result.remoteInstanceId).toBe(remoteInstanceId);

    // Verify the row was persisted.
    const row = await prisma.remoteUser.findUnique({ where: { remoteUserId } });
    expect(row).not.toBeNull();
    expect(row?.displayNameCache).toBe('Carol');
  });

  // ─── 3. Stale cache ───────────────────────────────────────────────────────

  it('re-fetches when lastSeenAt is older than 1 hour', async () => {
    const localpart = 'dave';
    const remoteUserId = `${localpart}@${peerHost}`;
    const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    const oldKey = randomBytes(32);
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId,
        remoteUserId,
        displayNameCache: 'Dave (stale)',
        avatarUrlCache: null,
        publicKey: oldKey,
        lastSeenAt: staleDate,
      },
    });

    vi.spyOn(fc, 'discoverInstance').mockResolvedValue(makePeerDiscovery());
    const response = makePeerProfileResponse({ localpart, displayName: 'Dave (fresh)' });
    vi.spyOn(fc, 'postProfileEnvelope').mockResolvedValue(response);

    const svc = makeService();
    const result = await svc.fetchRemoteProfile(remoteUserId);

    expect(fc.discoverInstance).toHaveBeenCalledWith(peerHost);
    expect(fc.postProfileEnvelope).toHaveBeenCalledOnce();
    expect(result.displayNameCache).toBe('Dave (fresh)');

    // DB row should be updated.
    const row = await prisma.remoteUser.findUnique({ where: { remoteUserId } });
    expect(row?.displayNameCache).toBe('Dave (fresh)');
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(staleDate.getTime());
  });

  // ─── 4. Non-peered host ───────────────────────────────────────────────────

  it('throws when the host RemoteInstance is not peered', async () => {
    // Flip the existing row to pending_inbound.
    await prisma.remoteInstance.update({
      where: { host: peerHost },
      data: { status: 'pending_inbound', peeredAt: null },
    });

    const svc = makeService();
    await expect(svc.fetchRemoteProfile(`eve@${peerHost}`)).rejects.toThrow(
      'is not a peered remote instance',
    );
  });

  // ─── 5. Malformed remoteUserId ────────────────────────────────────────────

  it('throws on malformed remoteUserId without an @', async () => {
    const svc = makeService();
    await expect(svc.fetchRemoteProfile('not-an-id')).rejects.toThrow('invalid remoteUserId');
  });

  it('throws on malformed remoteUserId with no host part', async () => {
    const svc = makeService();
    await expect(svc.fetchRemoteProfile('alice@')).rejects.toThrow('invalid remoteUserId');
  });

  it('throws on malformed remoteUserId with no localpart', async () => {
    const svc = makeService();
    await expect(svc.fetchRemoteProfile('@b.example')).rejects.toThrow('invalid remoteUserId');
  });

  // ─── 6. Bad response signature ────────────────────────────────────────────

  it('throws when the response is signed by a different key than discoverInstance advertises', async () => {
    const localpart = 'frank';
    const remoteUserId = `${localpart}@${peerHost}`;
    const attackerKp = generateKeyPair();

    vi.spyOn(fc, 'discoverInstance').mockResolvedValue(makePeerDiscovery()); // advertises peerKp
    // Response signed by attacker key — different from peerKp.
    const response = makePeerProfileResponse({
      localpart,
      displayName: 'Frank',
      signingKey: attackerKp,
    });
    vi.spyOn(fc, 'postProfileEnvelope').mockResolvedValue(response);

    const svc = makeService();
    await expect(svc.fetchRemoteProfile(remoteUserId)).rejects.toThrow(
      'signature/shape invalid',
    );

    // No RemoteUser row should have been created.
    const row = await prisma.remoteUser.findUnique({ where: { remoteUserId } });
    expect(row).toBeNull();
  });

  // ─── getCachedRemoteProfile ───────────────────────────────────────────────

  it('getCachedRemoteProfile returns null when no row exists', async () => {
    const svc = makeService();
    const result = await svc.getCachedRemoteProfile(`nobody@${peerHost}`);
    expect(result).toBeNull();
  });

  it('getCachedRemoteProfile returns the row regardless of staleness', async () => {
    const remoteUserId = `grace@${peerHost}`;
    const userPublicKey = randomBytes(32);
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId,
        remoteUserId,
        displayNameCache: 'Grace',
        avatarUrlCache: 'https://b.example/avatar/grace.png',
        publicKey: userPublicKey,
        lastSeenAt: staleDate,
      },
    });

    const svc = makeService();
    const result = await svc.getCachedRemoteProfile(remoteUserId);

    expect(result).not.toBeNull();
    expect(result?.displayNameCache).toBe('Grace');
    expect(result?.avatarUrlCache).toBe('https://b.example/avatar/grace.png');
  });
});
