import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext,
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
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: 'https://a.example',
  } as NodeJS.ProcessEnv;
}

describe.skipIf(!dockerOk)('federation profile — inbound (phase 2)', () => {
  beforeEach(async () => {
    await prisma.federationEnvelopeLog.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    await prisma.federationKey.deleteMany({});
    // Server rows from prior test files can block user deletion via FK.
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('happy path: peered peer + existing local user → 200 signed profile.response', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';

    // Seed a peered RemoteInstance
    await prisma.remoteInstance.create({
      data: {
        id: ulid(),
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });

    // Seed a local user with an avatar attachment
    const userId = ulid();
    const username = `alice-${userId.slice(-6).toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: userId,
        username,
        usernameLower: username,
        displayName: 'Alice Test',
        email: `${username}@example.com`,
        emailLower: `${username}@example.com`,
        passwordHash: 'x',
        avatarAttachmentId: null,
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const envelope = buildSignedEnvelope({
      eventType: 'profile.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { localpart: username },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/profile',
      payload: envelope,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eventType).toBe('profile.response');
    expect(body.fromInstance).toBe('a.example');
    expect(body.toInstance).toBe(peerHost);
    expect(body.payload).toBeDefined();
    expect(body.payload.displayName).toBe('Alice Test');
    expect(body.payload.remoteUserId).toBe(`${username}@a.example`);
    expect(body.payload.publicKey).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
    expect(body.signature).toBeDefined();
    // avatarUrl is null/undefined when no attachment
    expect(body.payload.avatarUrl == null).toBe(true);

    await app.close();
  });

  it('unknown user: peered peer but non-existent localpart → 404', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';

    await prisma.remoteInstance.create({
      data: {
        id: ulid(),
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const envelope = buildSignedEnvelope({
      eventType: 'profile.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { localpart: 'ghost-does-not-exist' },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/profile',
      payload: envelope,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/no user/);

    await app.close();
  });

  it('unpeered peer: RemoteInstance exists but status=pending_inbound → 403', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';

    await prisma.remoteInstance.create({
      data: {
        id: ulid(),
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'pending_inbound',
        capabilities: ['messages'],
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const envelope = buildSignedEnvelope({
      eventType: 'profile.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { localpart: 'alice' },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/profile',
      payload: envelope,
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/pending_inbound/);

    await app.close();
  });

  it('unknown peer: no RemoteInstance row for fromInstance → 403', async () => {
    const peerKp = generateKeyPair();
    const peerHost = 'unknown.example';

    // No RemoteInstance row seeded for this host.

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const envelope = buildSignedEnvelope({
      eventType: 'profile.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { localpart: 'alice' },
      sign: (bytes) => edSign(bytes, peerKp.privateKey),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/profile',
      payload: envelope,
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not a known peer/);

    await app.close();
  });

  it('bad signature: envelope signed with a different key → 401', async () => {
    const peerKp = generateKeyPair();
    const attackerKp = generateKeyPair();
    const peerHost = 'b.example';

    // Stored key is peerKp, but envelope is signed by attackerKp
    await prisma.remoteInstance.create({
      data: {
        id: ulid(),
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const envelope = buildSignedEnvelope({
      eventType: 'profile.request',
      fromInstance: peerHost,
      toInstance: 'a.example',
      payload: { localpart: 'alice' },
      sign: (bytes) => edSign(bytes, attackerKp.privateKey), // wrong key
    });

    const res = await app.inject({
      method: 'POST',
      url: '/_federation/profile',
      payload: envelope,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.success).toBe(false);

    await app.close();
  });
});
