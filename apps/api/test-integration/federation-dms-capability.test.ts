/**
 * P5-11 — `dms` capability advertisement + per-peer gating + per-instance
 * opt-out via `FEDERATION_DMS_ENABLED`.
 *
 * Coverage matrix:
 *   1. Well-known advertises `dms` by default — GET `/.well-known/tavern-
 *      federation` includes `'dms'` in the capabilities array when the env
 *      var is unset (or `true`).
 *   2. `FEDERATION_DMS_ENABLED=false` strips `dms` from the well-known doc
 *      while keeping the other capabilities intact.
 *   3. Peering handshake intersects requested + locally-advertised
 *      capabilities into `RemoteInstance.capabilities`. With local =
 *      ['messages', 'invites', 'dms'] and peer requesting ['messages',
 *      'invites'] the result is ['messages', 'invites'] — no `dms` because
 *      the peer didn't ask for it.
 *   4. Outbound fan-out skips a peer whose `RemoteInstance.capabilities`
 *      doesn't include `dms`. Alice opens a DM with bob (remote); peer
 *      capabilities = ['messages']; the POST returns 200 but NO outbox
 *      enqueue fires.
 *   5. Inbound rejects every `dm.*` envelope with 403 when THIS instance
 *      has `FEDERATION_DMS_ENABLED=false`, regardless of the peer's stored
 *      capability set.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
import {
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSign,
  buildTwoLayerMessageEnvelope,
} from '@tavern/federation';
import { buildSignedEnvelope } from '../src/services/federation-envelopes.js';
import * as fc from '../src/services/federation-client.js';
import { JwtService } from '../src/lib/jwt.js';
import type { FederationOutboxJob } from '@tavern/federation';

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

const SELF_HOST = 'self.example';
const PEER_HOST = 'b.example';

/**
 * Build a base env block. `dmsEnabled` is `true | false | undefined` — undefined
 * leaves the env var unset so we exercise the `default('true')` branch in the
 * config schema (test 1).
 */
function envFor(opts: {
  dbUrl: string;
  dmsEnabled?: boolean;
  federationEnabled?: boolean;
}): NodeJS.ProcessEnv {
  const out: Record<string, string> = {
    DATABASE_URL: opts.dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: opts.federationEnabled === false ? 'false' : 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  };
  if (opts.dmsEnabled !== undefined) {
    out.FEDERATION_DMS_ENABLED = opts.dmsEnabled ? 'true' : 'false';
  }
  return out as NodeJS.ProcessEnv;
}

/** Wipe every row touched by these tests. Mirrors the helper used by other suites. */
async function cleanDb(): Promise<void> {
  // Delete in FK-safe order: child tables before parent tables.
  // Server.ownerUserId has onDelete: Restrict, so servers must be cleared
  // before users. This ensures the function works when run after any other
  // test file that may have left Server rows in the shared DB.
  await prisma.apiToken.deleteMany({});
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  await prisma.federationKey.deleteMany({});
}

async function mintTokenFor(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: {
      id: ulid(),
      userId,
      label: 'test',
      tokenHash: hash,
    },
  });
  return raw;
}

async function makeAuthedAdminToken(): Promise<{ userId: string; token: string }> {
  const jwt = new JwtService({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 7,
  });
  const userId = ulid();
  const sessionId = ulid();
  const username = `admin-${userId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@example.com`,
      emailLower: `${username}@example.com`,
      passwordHash: 'x',
      isInstanceAdmin: true,
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

// ─── Test 1 + 2: well-known advertisement ────────────────────────────────────

describe.skipIf(!dockerOk)('P5-11 — well-known capability advertisement', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it("advertises 'dms' in capabilities by default", async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    // No FEDERATION_DMS_ENABLED override → exercises the schema default.
    const app = await buildApp({ config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl })) });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/tavern-federation',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.capabilities).toContain('dms');
      // Sanity — the other capabilities are still there.
      expect(body.capabilities).toContain('messages');
      expect(body.capabilities).toContain('invites');
    } finally {
      await app.close();
    }
  });

  it("strips 'dms' from capabilities when FEDERATION_DMS_ENABLED=false", async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl, dmsEnabled: false })),
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/tavern-federation',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.capabilities).not.toContain('dms');
      // Other capabilities must remain — this flag is DM-only.
      expect(body.capabilities).toContain('messages');
      expect(body.capabilities).toContain('invites');
    } finally {
      await app.close();
    }
  });
});

// ─── Test 3: peering handshake intersection ──────────────────────────────────

describe.skipIf(!dockerOk)('P5-11 — peering handshake intersects capabilities', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
    vi.restoreAllMocks();
  });

  it('inbound: RemoteInstance.capabilities is the intersection of local-advertised and what the peer requested', async () => {
    const peerKp = generateKeyPair();
    // Peer asks for 'messages' + 'invites' only (no 'dms'). The local
    // instance advertises the full set including 'dms'. The intersection
    // should be ['messages', 'invites'].
    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
      instance: PEER_HOST,
      softwareVersion: 'tavern/0.0.0',
      protocolVersion: 'ir20/1',
      instanceKey: `ed25519:${exportPublicKeyRaw(peerKp.publicKey).toString('base64')}`,
      endpoints: {
        peering: `https://${PEER_HOST}/_federation/peering`,
        events: `wss://${PEER_HOST}/_federation/events`,
        backfill: `https://${PEER_HOST}/_federation/backfill`,
      },
      capabilities: ['messages', 'invites'],
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({ config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl })) });
    try {
      const envelope = buildSignedEnvelope({
        eventType: 'peering.request',
        fromInstance: PEER_HOST,
        toInstance: SELF_HOST,
        payload: {
          requestedCapabilities: ['messages', 'invites'],
          note: 'no dms please',
        },
        sign: (bytes) => edSign(bytes, peerKp.privateKey),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/peering',
        payload: envelope,
      });
      expect(res.statusCode).toBe(202);
      const row = await prisma.remoteInstance.findUnique({ where: { host: PEER_HOST } });
      expect(row?.capabilities).toEqual(['messages', 'invites']);
    } finally {
      await app.close();
    }
  });

  it('inbound: only stores the intersection with local-advertised when this instance has FEDERATION_DMS_ENABLED=false', async () => {
    const peerKp = generateKeyPair();
    // The peer asks for the full set INCLUDING 'dms'. The local instance
    // has FEDERATION_DMS_ENABLED=false, so it should drop 'dms' from the
    // intersection even though the peer wanted it.
    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
      instance: PEER_HOST,
      softwareVersion: 'tavern/0.0.0',
      protocolVersion: 'ir20/1',
      instanceKey: `ed25519:${exportPublicKeyRaw(peerKp.publicKey).toString('base64')}`,
      endpoints: {
        peering: `https://${PEER_HOST}/_federation/peering`,
        events: `wss://${PEER_HOST}/_federation/events`,
        backfill: `https://${PEER_HOST}/_federation/backfill`,
      },
      capabilities: ['messages', 'dms', 'invites'],
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl, dmsEnabled: false })),
    });
    try {
      const envelope = buildSignedEnvelope({
        eventType: 'peering.request',
        fromInstance: PEER_HOST,
        toInstance: SELF_HOST,
        payload: { requestedCapabilities: ['messages', 'dms', 'invites'] },
        sign: (bytes) => edSign(bytes, peerKp.privateKey),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/peering',
        payload: envelope,
      });
      expect(res.statusCode).toBe(202);
      const row = await prisma.remoteInstance.findUnique({ where: { host: PEER_HOST } });
      expect(row?.capabilities).not.toContain('dms');
      expect(row?.capabilities).toContain('messages');
      expect(row?.capabilities).toContain('invites');
    } finally {
      await app.close();
    }
  });

  it('outbound: initiatePeering intersects requested + peer-advertised + local-advertised', async () => {
    const { token } = await makeAuthedAdminToken();
    const peerKp = generateKeyPair();
    // Peer's discovery doc advertises ['messages', 'invites'] (no 'dms').
    // The admin asks for the full set. The locally-stored row should be
    // the intersection — no 'dms', because the peer doesn't accept it.
    vi.spyOn(fc, 'discoverInstance').mockResolvedValue({
      instance: PEER_HOST,
      softwareVersion: 'tavern/0.0.0',
      protocolVersion: 'ir20/1',
      instanceKey: `ed25519:${exportPublicKeyRaw(peerKp.publicKey).toString('base64')}`,
      endpoints: {
        peering: `https://${PEER_HOST}/_federation/peering`,
        events: `wss://${PEER_HOST}/_federation/events`,
        backfill: `https://${PEER_HOST}/_federation/backfill`,
      },
      capabilities: ['messages', 'invites'],
    });
    vi.spyOn(fc, 'postPeeringEnvelope').mockResolvedValue({ id: 'log-1' });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({ config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl })) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/peers',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          host: PEER_HOST,
          requestedCapabilities: ['messages', 'dms', 'invites'],
        },
      });
      expect(res.statusCode).toBe(201);
      const row = await prisma.remoteInstance.findUnique({ where: { host: PEER_HOST } });
      expect(row?.capabilities).toEqual(['messages', 'invites']);
    } finally {
      await app.close();
    }
  });
});

// ─── Test 4: outbound fan-out skips when peer lacks 'dms' ────────────────────

describe.skipIf(!dockerOk)('P5-11 — outbound fan-out gating', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it("skips dm.create enqueue when the peer's stored capabilities don't include 'dms'", async () => {
    // Local user alice.
    const aliceId = ulid();
    const aliceUsername = `alice-${aliceId.slice(-6).toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: aliceId,
        username: aliceUsername,
        usernameLower: aliceUsername,
        displayName: 'Alice',
        email: `${aliceId.toLowerCase()}@${SELF_HOST}`,
        emailLower: `${aliceId.toLowerCase()}@${SELF_HOST}`,
        passwordHash: 'x',
      },
    });

    // Remote peer that advertises 'messages' but NOT 'dms'.
    const peerInstanceId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerInstanceId,
        host: PEER_HOST,
        instanceKey: randomBytes(32),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });

    // Remote user bob mirrored locally as a synthetic User row.
    const bobRemoteUserId = `bob@${PEER_HOST}`;
    const bobLocalId = ulid();
    const bobSyntheticUsername = `__rem_${bobLocalId.toLowerCase()}`;
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: peerInstanceId,
        remoteUserId: bobRemoteUserId,
        displayNameCache: 'Bob',
        avatarUrlCache: null,
        publicKey: randomBytes(32),
      },
    });
    await prisma.user.create({
      data: {
        id: bobLocalId,
        username: bobSyntheticUsername,
        usernameLower: bobSyntheticUsername,
        displayName: 'Bob',
        email: `${bobLocalId.toLowerCase()}@${PEER_HOST}.federated.local`,
        emailLower: `${bobLocalId.toLowerCase()}@${PEER_HOST}.federated.local`,
        passwordHash: null,
        remoteUserId: bobRemoteUserId,
        remoteInstanceId: peerInstanceId,
      },
    });

    // Shared server so the `usersShareServer` check passes.
    const serverId = ulid();
    const roleId = ulid();
    await prisma.server.create({
      data: {
        id: serverId,
        ownerUserId: aliceId,
        name: 'Test',
        federationEnabled: true,
      },
    });
    await prisma.role.create({
      data: {
        id: roleId,
        serverId,
        name: '@everyone',
        isEveryone: true,
        permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
      },
    });
    await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: roleId } });
    await prisma.serverMember.create({ data: { serverId, userId: aliceId } });
    await prisma.serverMember.create({ data: { serverId, userId: bobLocalId } });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl })),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: bobLocalId },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      // The route-level call may invoke the helper, but the helper's
      // capability gate fires inside, so no envelope is enqueued.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ─── Test 5: inbound rejects when local FEDERATION_DMS_ENABLED=false ─────────

describe.skipIf(!dockerOk)('P5-11 — inbound DM rejection when local opted out', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it("rejects inbound dm.create with 403 dms_capability_missing when FEDERATION_DMS_ENABLED=false, even if the peer's stored capabilities still include 'dms'", async () => {
    const peerKp = generateKeyPair();
    const initiatorKp = generateKeyPair();
    const peerInstanceId = ulid();
    const initiatorLocalpart = `bob-${peerInstanceId.slice(-6).toLowerCase()}`;
    const initiatorRemoteUserId = `${initiatorLocalpart}@${PEER_HOST}`;
    // Peer row claims to support 'dms' (stale from before the local
    // operator flipped FEDERATION_DMS_ENABLED off). The instance-level
    // gate must STILL reject the envelope.
    await prisma.remoteInstance.create({
      data: {
        id: peerInstanceId,
        host: PEER_HOST,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages', 'dms'],
        peeredAt: new Date(),
      },
    });
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: peerInstanceId,
        remoteUserId: initiatorRemoteUserId,
        displayNameCache: 'Bob',
        avatarUrlCache: null,
        publicKey: exportPublicKeyRaw(initiatorKp.publicKey),
      },
    });
    // Local recipient so the handler would otherwise find them — proves the
    // 403 is from the capability gate, not from `unknown_recipient`.
    const aliceId = ulid();
    const aliceUsername = `alice-${aliceId.slice(-6).toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: aliceId,
        username: aliceUsername,
        usernameLower: aliceUsername,
        displayName: 'Alice',
        email: `${aliceUsername}@${SELF_HOST}`,
        emailLower: `${aliceUsername}@${SELF_HOST}`,
        passwordHash: 'x',
      },
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl, dmsEnabled: false })),
    });
    try {
      const envelope = buildTwoLayerMessageEnvelope({
        eventType: 'dm.create',
        fromInstance: PEER_HOST,
        toInstance: SELF_HOST,
        payload: {
          dmChannelId: ulid(),
          initiatorRemoteUserId,
          recipientRemoteUserId: `${aliceUsername}@${SELF_HOST}`,
          createdAt: new Date().toISOString(),
        },
        signUser: (b: Buffer) => edSign(b, initiatorKp.privateKey),
        signInstance: (b: Buffer) => edSign(b, peerKp.privateKey),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/dms/i);
      // No DmChannel created.
      const channels = await prisma.dmChannel.findMany({});
      expect(channels).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("accepts inbound dm.create when FEDERATION_DMS_ENABLED is left at the default (true)", async () => {
    // Sanity check that the previous test's failure isn't due to broken
    // fixture wiring — flip the flag back to its default and confirm the
    // same envelope is accepted.
    const peerKp = generateKeyPair();
    const initiatorKp = generateKeyPair();
    const peerInstanceId = ulid();
    const initiatorLocalpart = `bob-${peerInstanceId.slice(-6).toLowerCase()}`;
    const initiatorRemoteUserId = `${initiatorLocalpart}@${PEER_HOST}`;
    await prisma.remoteInstance.create({
      data: {
        id: peerInstanceId,
        host: PEER_HOST,
        instanceKey: exportPublicKeyRaw(peerKp.publicKey),
        status: 'peered',
        capabilities: ['messages', 'dms'],
        peeredAt: new Date(),
      },
    });
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: peerInstanceId,
        remoteUserId: initiatorRemoteUserId,
        displayNameCache: 'Bob',
        avatarUrlCache: null,
        publicKey: exportPublicKeyRaw(initiatorKp.publicKey),
      },
    });
    const aliceId = ulid();
    const aliceUsername = `alice-${aliceId.slice(-6).toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: aliceId,
        username: aliceUsername,
        usernameLower: aliceUsername,
        displayName: 'Alice',
        email: `${aliceUsername}@${SELF_HOST}`,
        emailLower: `${aliceUsername}@${SELF_HOST}`,
        passwordHash: 'x',
      },
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl })),
    });
    try {
      const dmChannelId = ulid();
      const envelope = buildTwoLayerMessageEnvelope({
        eventType: 'dm.create',
        fromInstance: PEER_HOST,
        toInstance: SELF_HOST,
        payload: {
          dmChannelId,
          initiatorRemoteUserId,
          recipientRemoteUserId: `${aliceUsername}@${SELF_HOST}`,
          createdAt: new Date().toISOString(),
        },
        signUser: (b: Buffer) => edSign(b, initiatorKp.privateKey),
        signInstance: (b: Buffer) => edSign(b, peerKp.privateKey),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const channels = await prisma.dmChannel.findMany({});
      expect(channels).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
