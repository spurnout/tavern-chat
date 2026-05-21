/**
 * P6-3 (follow-up #29) — inbound `peering.accept` envelope handler.
 *
 * Phase 5 left a one-sided gap in the peering handshake: the initiator never
 * reconciled the peer's accepted capability set after the response envelope
 * was sent. The new inbound handler closes this by accepting an inbound
 * `peering.accept` from the peer that we originally `peering.request`'d, and
 * flipping our `RemoteInstance` row from `pending_outbound` → `peered` with
 * the negotiated capability intersection.
 *
 * NOTE: This suite requires Docker (testcontainers Postgres). Same posture as
 * the rest of the Phase 3–5 integration suites — when Docker is unavailable
 * the suite is skipped, not failed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSign,
} from '../src/lib/ed25519.js';
import { buildSignedEnvelope } from '../src/services/federation-envelopes.js';
import * as fc from '../src/services/federation-client.js';
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

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'https://a.example',
  } as NodeJS.ProcessEnv;
}

function mockDiscovery(peerHost: string, peerPubRaw: Buffer, capabilities: string[] = ['messages', 'dms']) {
  vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
    instance: peerHost,
    softwareVersion: 'tavern/0.0.0',
    protocolVersion: 'ir20/1',
    instanceKey: `ed25519:${peerPubRaw.toString('base64')}`,
    endpoints: {
      peering: `https://${peerHost}/_federation/peering`,
      events: `wss://${peerHost}/_federation/events`,
      backfill: `https://${peerHost}/_federation/backfill`,
    },
    capabilities: capabilities as never,
  });
}

describe.skipIf(!dockerOk)('federation peering — inbound peering.accept (P6-3 / follow-up #29)', () => {
  beforeEach(async () => {
    await prisma.federationEnvelopeLog.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    await prisma.federationKey.deleteMany({});
    vi.restoreAllMocks();
  });

  it('happy path: flips pending_outbound → peered and intersects capabilities', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    mockDiscovery(peerHost, peerPubRaw);

    // Pre-seed: we already initiated a peering.request and have a pending_outbound row.
    const remoteId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: peerPubRaw,
        status: 'pending_outbound',
        capabilities: ['messages', 'dms'],
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      // Peer accepted only `messages` (e.g. peer doesn't actually support dms locally).
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(202);

    const row = await prisma.remoteInstance.findUnique({ where: { id: remoteId } });
    expect(row?.status).toBe('peered');
    expect(row?.peeredAt).not.toBeNull();
    // Capability intersection: local advertises all of CAPABILITIES, peer
    // accepted only 'messages' → row stores ['messages'].
    expect(row?.capabilities).toEqual(['messages']);

    const log = await prisma.federationEnvelopeLog.findFirst({
      where: { peerInstanceId: remoteId, eventType: 'peering.accept' },
    });
    expect(log).not.toBeNull();
    expect(log?.direction).toBe('inbound');

    await app.close();
  });

  it('re-handshake: already-peered row stays peered but capabilities shrink', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    mockDiscovery(peerHost, peerPubRaw);

    const peeredAt = new Date(Date.now() - 60_000);
    const remoteId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: peerPubRaw,
        status: 'peered',
        capabilities: ['messages', 'dms'],
        peeredAt,
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      // Peer dropped `dms` from its advertised set.
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(202);

    const row = await prisma.remoteInstance.findUnique({ where: { id: remoteId } });
    expect(row?.status).toBe('peered');
    expect(row?.capabilities).toEqual(['messages']);
    // peeredAt is preserved (we don't reset the timestamp on re-handshake).
    expect(row?.peeredAt?.getTime()).toBe(peeredAt.getTime());

    await app.close();
  });

  it('rejects peering.accept from an unknown peer with 400 bad_envelope', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    mockDiscovery(peerHost, peerPubRaw);

    // No pre-seeded RemoteInstance row.
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error?: string };
    expect(body.error).toContain('unknown peer');

    // No row created and no log entry.
    const row = await prisma.remoteInstance.findUnique({ where: { host: peerHost } });
    expect(row).toBeNull();

    await app.close();
  });

  it('rejects peering.accept on a revoked peer with 403 blocked', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    mockDiscovery(peerHost, peerPubRaw);

    const remoteId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: peerPubRaw,
        status: 'revoked',
        capabilities: ['messages'],
        revokedAt: new Date(),
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(403);

    const row = await prisma.remoteInstance.findUnique({ where: { id: remoteId } });
    expect(row?.status).toBe('revoked'); // unchanged

    await app.close();
  });

  it('rejects peering.accept on a blocked peer with 403 blocked', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    mockDiscovery(peerHost, peerPubRaw);

    const remoteId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: peerPubRaw,
        status: 'blocked',
        capabilities: ['messages'],
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects peering.accept with mismatched signature (401 signature)', async () => {
    const peerKp = generateKeyPair();
    const attackerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    // Discovery returns the peer's real public key, but the envelope is signed
    // by an attacker.
    mockDiscovery(peerHost, peerPubRaw);

    const remoteId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: peerPubRaw,
        status: 'pending_outbound',
        capabilities: ['messages'],
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, attackerKp.privateKey), // wrong key
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(401);

    const row = await prisma.remoteInstance.findUnique({ where: { id: remoteId } });
    // Row stays untouched on signature failure.
    expect(row?.status).toBe('pending_outbound');

    await app.close();
  });

  it('rejects a replayed peering.accept envelope with 409 replay', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const peerPubRaw = exportPublicKeyRaw(peerKp.publicKey);
    mockDiscovery(peerHost, peerPubRaw);

    const remoteId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: peerPubRaw,
        status: 'pending_outbound',
        capabilities: ['messages'],
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.accept',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { acceptedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const first = await app.inject({ method: 'POST', url: '/_federation/peering', payload: envelope });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: '/_federation/peering', payload: envelope });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it('route 400s on unknown eventType', async () => {
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: { eventType: 'peering.frobnicate', fromInstance: 'b.example' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error?: string };
    expect(body.error).toContain('unsupported eventType');
    await app.close();
  });
});
