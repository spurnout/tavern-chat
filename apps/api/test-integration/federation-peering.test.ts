import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
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
import * as fc from '../src/services/federation-client.js';
import { JwtService } from '../src/lib/jwt.js';
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

describe.skipIf(!dockerOk)('federation peering — admin (phase 1)', () => {
  /**
   * Helper: create a user + session and return a signed JWT bearer token.
   * The envFor() secrets are deterministic ('a'.repeat(48) / 'b'.repeat(48)),
   * so we can sign tokens here with the same keys without needing an HTTP login.
   */
  async function makeAuthedUser(opts: { isInstanceAdmin: boolean }): Promise<{
    userId: string;
    token: string;
  }> {
    const jwt = new JwtService({
      accessSecret: 'a'.repeat(48),
      refreshSecret: 'b'.repeat(48),
      accessTtlSeconds: 60 * 15,
      refreshTtlSeconds: 60 * 60 * 24 * 7,
    });
    const userId = ulid();
    const sessionId = ulid();
    const username = `user-${userId.slice(-6)}`;
    await prisma.user.create({
      data: {
        id: userId,
        username,
        usernameLower: username,
        displayName: username,
        email: `${username}@example.com`,
        emailLower: `${username}@example.com`,
        passwordHash: 'x',
        isInstanceAdmin: opts.isInstanceAdmin,
      },
    });
    await prisma.session.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const { token } = await jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });
    return { userId, token };
  }

  beforeEach(async () => {
    await prisma.federationEnvelopeLog.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    await prisma.federationKey.deleteMany({});
    await prisma.session.deleteMany({});
    // Server rows from prior test files can block user deletion via FK.
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
    vi.restoreAllMocks();
  });

  it('admin initiates peering: creates a pending_outbound row and POSTs to the peer', async () => {
    const { token } = await makeAuthedUser({ isInstanceAdmin: true });
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
    vi.spyOn(fc, 'postPeeringEnvelope').mockResolvedValue({ id: 'log-1' });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/peers',
      headers: { authorization: `Bearer ${token}` },
      payload: { host: peerHost, requestedCapabilities: ['messages'] },
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.remoteInstance.findUnique({ where: { host: peerHost } });
    expect(row?.status).toBe('pending_outbound');
    expect(fc.postPeeringEnvelope).toHaveBeenCalledOnce();
    await app.close();
  });

  it('admin approves a pending_inbound peer: status becomes peered and dispatches a peering.accept envelope', async () => {
    const { token, userId: adminUserId } = await makeAuthedUser({ isInstanceAdmin: true });
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const remoteId = ulid();

    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'pending_inbound',
        capabilities: ['messages'],
      },
    });

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
    vi.spyOn(fc, 'postPeeringEnvelope').mockResolvedValue({ id: 'log-2' });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/peers/${remoteId}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.remoteInstance.findUnique({ where: { id: remoteId } });
    expect(row?.status).toBe('peered');
    expect(fc.postPeeringEnvelope).toHaveBeenCalledOnce();
    const callArg = (fc.postPeeringEnvelope as ReturnType<typeof vi.fn>).mock.calls[0][1] as { eventType: string };
    expect(callArg.eventType).toBe('peering.accept');
    // suppress unused var warning
    void adminUserId;
    await app.close();
  });

  it('admin revokes a peered peer: status becomes revoked and dispatches a peering.revoke envelope', async () => {
    const { token } = await makeAuthedUser({ isInstanceAdmin: true });
    const peerKp = generateKeyPair();
    const peerHost = 'b.example';
    const remoteId = ulid();

    await prisma.remoteInstance.create({
      data: {
        id: remoteId,
        host: peerHost,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });

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
    vi.spyOn(fc, 'postPeeringEnvelope').mockResolvedValue({ id: 'log-3' });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/peers/${remoteId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'no thanks' },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.remoteInstance.findUnique({ where: { id: remoteId } });
    expect(row?.status).toBe('revoked');
    expect(row?.revokedReason).toBe('no thanks');
    expect(fc.postPeeringEnvelope).toHaveBeenCalledOnce();
    const callArg = (fc.postPeeringEnvelope as ReturnType<typeof vi.fn>).mock.calls[0][1] as { eventType: string };
    expect(callArg.eventType).toBe('peering.revoke');
    await app.close();
  });

  it('non-admin user gets 403 on admin endpoints', async () => {
    const { token } = await makeAuthedUser({ isInstanceAdmin: false });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/peers',
      headers: { authorization: `Bearer ${token}` },
      payload: { host: 'c.example', requestedCapabilities: ['messages'] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
