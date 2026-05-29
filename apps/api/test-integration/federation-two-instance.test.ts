import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  isDockerAvailable,
  startPostgres,
  startSecondPostgres,
  stopPostgres,
  type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
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

let ctxA: IntegrationContext | null = null;
let ctxB: IntegrationContext | null = null;
const dockerOk = await isDockerAvailable();

beforeAll(async () => {
  if (!dockerOk) return;
  ctxA = await startPostgres();   // primary container
  ctxB = await startSecondPostgres();  // new second container
}, 180_000);  // longer timeout for two containers

afterAll(async () => {
  // stopPostgres checks for null
  if (ctxB) await stopPostgres(ctxB);
  // ctxA is managed by the global teardown
});

function envForA(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: 'https://a.example',
  } as NodeJS.ProcessEnv;
}

function envForB(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'c'.repeat(48),
    JWT_REFRESH_SECRET: 'd'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: 'https://b.example',
  } as NodeJS.ProcessEnv;
}

describe.skipIf(!dockerOk)('two-instance federation smoke test', () => {
  beforeEach(async () => {
    if (!dockerOk || !ctxA) return;
    // The primary container (ctxA) is shared across the whole integration run.
    // Other files (e.g. federation-peering) leave 'peered' remoteInstance rows
    // for these hosts behind — they only clean in their own beforeEach, not
    // after their last test. Reset A's peering tables (FK-safe order: envelope
    // log references remoteInstance) so this file's pending_inbound assertion
    // reads a fresh row rather than a stale 'peered' one.
    await ctxA.prisma.federationEnvelopeLog.deleteMany({});
    await ctxA.prisma.remoteInstance.deleteMany({});
  });

  it('appA and appB have isolated databases via prismaOverride', async () => {
    // Build two isolated apps with their own prisma clients
    const appA = await buildApp({
      config: loadConfig(envForA(ctxA!.databaseUrl)),
      prismaOverride: ctxA!.prisma,
    });
    const appB = await buildApp({
      config: loadConfig(envForB(ctxB!.databaseUrl)),
      prismaOverride: ctxB!.prisma,
    });

    // Create a user in A's database
    const userId = ulid();
    const username = `alice-${userId.slice(-6).toLowerCase()}`;
    await ctxA!.prisma.user.create({
      data: {
        id: userId,
        username,
        usernameLower: username,
        displayName: 'Alice',
        email: `${username}@a.example`,
        emailLower: `${username}@a.example`,
        passwordHash: 'x',
      },
    });

    // B's database should NOT have this user
    const userInB = await ctxB!.prisma.user.findUnique({ where: { id: userId } });
    expect(userInB).toBeNull();

    // B's .well-known endpoint should show PUBLIC_BASE_URL = b.example
    const wellKnownRes = await appB.inject({
      method: 'GET',
      url: '/.well-known/tavern-federation',
    });
    expect(wellKnownRes.statusCode).toBe(200);
    const wk = wellKnownRes.json();
    expect(wk.instance).toBe('b.example');

    // A's .well-known endpoint should show a.example
    const wellKnownResA = await appA.inject({
      method: 'GET',
      url: '/.well-known/tavern-federation',
    });
    expect(wellKnownResA.statusCode).toBe(200);
    expect(wellKnownResA.json().instance).toBe('a.example');

    await appA.close();
    await appB.close();
  });

  it('inbound peering request routes to the correct isolated database', async () => {
    // Seed B's database with a peering request from A
    const bKp = generateKeyPair();

    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
      instance: 'a.example',
      softwareVersion: 'tavern/0.0.0',
      protocolVersion: 'ir20/1',
      instanceKey: `ed25519:${exportPublicKeyRaw(bKp.publicKey).toString('base64')}`,
      endpoints: {
        peering: 'https://a.example/_federation/peering',
        events: 'wss://a.example/_federation/events',
        backfill: 'https://a.example/_federation/backfill',
      },
      capabilities: ['messages'],
    });

    const appA = await buildApp({
      config: loadConfig(envForA(ctxA!.databaseUrl)),
      prismaOverride: ctxA!.prisma,
    });

    const envelope = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: 'b.example',
      toInstance: 'a.example',
      payload: { requestedCapabilities: ['messages'] },
      sign: (bytes) => edSign(bytes, bKp.privateKey),
    });

    const res = await appA.inject({
      method: 'POST',
      url: '/_federation/peering',
      payload: envelope,
    });
    expect(res.statusCode).toBe(202);

    // The peering row should exist in A's database only
    const rowInA = await ctxA!.prisma.remoteInstance.findUnique({ where: { host: 'b.example' } });
    expect(rowInA).not.toBeNull();
    expect(rowInA?.status).toBe('pending_inbound');

    // B's database should have NO peering row
    const rowInB = await ctxB!.prisma.remoteInstance.findUnique({ where: { host: 'b.example' } });
    expect(rowInB).toBeNull();

    vi.restoreAllMocks();
    await appA.close();
  });
});
