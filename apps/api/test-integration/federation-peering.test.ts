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

describe.skipIf(!dockerOk)('federation peering — inbound (phase 1)', () => {
  beforeEach(async () => {
    await prisma.federationEnvelopeLog.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    await prisma.federationKey.deleteMany({});
    vi.restoreAllMocks();
  });

  it('accepts a well-formed inbound PeeringRequest envelope', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
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
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { requestedCapabilities: ['messages'], note: 'hi' },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(202);
    const row = await prisma.remoteInstance.findUnique({ where: { host: peerHost } });
    expect(row?.status).toBe('pending_inbound');
    await app.close();
  });

  it('rejects a replayed envelope with the same nonce (409)', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
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
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { requestedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const first = await app.inject({ method: 'POST', url: '/_federation/peering', payload: envelope });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: '/_federation/peering', payload: envelope });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it('rejects an envelope whose signature does not verify (401)', async () => {
    const peerKp = generateKeyPair();
    const attackerKp = generateKeyPair();
    const peerHost = 'b.example';
    // discovery returns the peer's pubkey, but the envelope is signed by an attacker
    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
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
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { requestedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, attackerKp.privateKey), // wrong key
    });
    const res = await app.inject({ method: 'POST', url: '/_federation/peering', payload: envelope });
    expect(res.statusCode).toBe(401);
    const row = await prisma.remoteInstance.findUnique({ where: { host: peerHost } });
    expect(row).toBeNull(); // nothing persisted on auth failure
    await app.close();
  });
});
