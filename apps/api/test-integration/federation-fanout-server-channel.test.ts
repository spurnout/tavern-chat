/**
 * P4-9 — outbound fan-out for server.update + channel.create/update/delete
 *
 * Coverage matrix:
 *   1. Server rename propagates: PATCH /api/servers/:id name → one enqueue
 *      per peer with eventType 'server.update'.
 *   2. Channel create propagates: POST /api/servers/:serverId/channels → one
 *      enqueue per peer with eventType 'channel.create'.
 *   3. Channel update propagates: PATCH /api/channels/:id name → one enqueue
 *      per peer with eventType 'channel.update'.
 *   4. Channel delete propagates: DELETE /api/channels/:id → one enqueue per
 *      peer with eventType 'channel.delete'.
 *   5. No fan-out when the server is non-federated (federationEnabled=false)
 *      — covers all four envelopes.
 *   6. No fan-out when the server is a MIRROR (originInstanceId != null).
 *      A does not push updates for B's mirror back to B (or to anyone).
 *   7. Channel.update STILL fans out when the PATCH sets federationMode to
 *      'force_off' — peers need to know to stop expecting messages there.
 *
 * The queue is a vi.fn() throughout — dispatch is covered by the federation-
 * outbox.test.ts suite from P3-5.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  channelCreatePayloadSchema,
  channelDeletePayloadSchema,
  channelUpdatePayloadSchema,
  serializePermissions,
  serverUpdatePayloadSchema,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
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

interface Fixture {
  ownerId: string;
  ownerUsername: string;
  serverId: string;
  channelId: string;
  peerAId: string;
  peerHost: string;
}

async function createUser(opts: {
  remoteInstanceId?: string;
  username?: string;
}): Promise<{ id: string; username: string }> {
  const id = ulid();
  const username = opts.username ?? `u-${id.slice(-8).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username,
      usernameLower: username.toLowerCase(),
      displayName: username,
      email: `${id.toLowerCase()}@example.com`,
      emailLower: `${id.toLowerCase()}@example.com`,
      passwordHash: opts.remoteInstanceId ? null : 'x',
      ...(opts.remoteInstanceId
        ? {
            remoteUserId: `${username}@peer-${opts.remoteInstanceId.toLowerCase()}.example`,
            remoteInstanceId: opts.remoteInstanceId,
          }
        : {}),
    },
  });
  return { id, username };
}

async function makeFixture(opts?: {
  federationEnabled?: boolean;
  isMirror?: boolean;
}): Promise<Fixture> {
  const owner = await createUser({ username: `owner-${ulid().slice(-6).toLowerCase()}` });
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();

  // Peered remote instance. Even for mirror-server fixtures we want a peer
  // wired up so the "would have fanned out" gate can be hit cleanly.
  const peerAId = ulid();
  const peerHost = `peer-${peerAId.toLowerCase()}.example`;
  await prisma.remoteInstance.create({
    data: {
      id: peerAId,
      host: peerHost,
      instanceKey: Buffer.alloc(32, 1),
      status: 'peered',
      capabilities: ['messages'],
    },
  });

  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: owner.id,
      name: 'Fed Tavern',
      federationEnabled: opts?.federationEnabled ?? true,
      // Mirror servers have a non-null originInstanceId pointing at the peer
      // that owns the upstream. Their owner is a synthetic remote user; we
      // simplify by re-using the local owner for the test fixture — the
      // route-level skip on originInstanceId != null doesn't depend on the
      // owner identity, only on the field being set.
      originInstanceId: opts?.isMirror ? peerAId : null,
    },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: { id: channelId, serverId, type: 'text', name: 'general' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: owner.id } });

  // Remote member from the peer so `findPeersWithRemoteMembers` returns
  // peerAId. Without this, the fan-out would no-op even for a federated,
  // non-mirror server — we want every test that gates on "should fan out"
  // to actually have a target.
  const remoteMember = await createUser({
    remoteInstanceId: peerAId,
    username: `rem-${ulid().slice(-6).toLowerCase()}`,
  });
  await prisma.serverMember.create({ data: { serverId, userId: remoteMember.id } });

  return {
    ownerId: owner.id,
    ownerUsername: owner.username,
    serverId,
    channelId,
    peerAId,
    peerHost,
  };
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

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: 'https://self.example',
  } as NodeJS.ProcessEnv;
}

async function cleanDb(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.messageEdit.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.userMention.deleteMany({});
  await prisma.pinnedMessage.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  // Each `buildApp` call provisions a fresh FederationKey with a random
  // TAVERN_DATA_KEY (see envFor). Without dropping the existing rows,
  // bootstrap re-reads the previous test's key and AES-GCM rejects it
  // (`Unsupported state or unable to authenticate data`). The first test
  // happens to pass because `cleanDb` runs in beforeEach.
  await prisma.federationKey.deleteMany({});
}

describe.skipIf(!dockerOk)('P4-9 — outbound fan-out (server + channel lifecycle)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('server rename propagates: PATCH /api/servers/:id name → server.update enqueued', async () => {
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Renamed Tavern' },
      });
      expect(patch.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('server.update');
      expect(job.authorUserId).toBe(fx.ownerId);
      const payload = serverUpdatePayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.name).toBe('Renamed Tavern');
    } finally {
      await app.close();
    }
  });

  it('channel create propagates: POST → channel.create enqueued', async () => {
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const post = await app.inject({
        method: 'POST',
        url: `/api/servers/${fx.serverId}/channels`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: 'text', name: 'lounge' },
      });
      expect(post.statusCode).toBe(201);
      const createdId = post.json().data.id as string;

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('channel.create');
      expect(job.authorUserId).toBe(fx.ownerId);
      const payload = channelCreatePayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.channel.id).toBe(createdId);
      expect(payload.channel.name).toBe('lounge');
      expect(payload.channel.type).toBe('text');
    } finally {
      await app.close();
    }
  });

  it('channel update propagates: PATCH name → channel.update enqueued', async () => {
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'renamed' },
      });
      expect(patch.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('channel.update');
      expect(job.authorUserId).toBe(fx.ownerId);
      const payload = channelUpdatePayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.channelId).toBe(fx.channelId);
      expect(payload.name).toBe('renamed');
    } finally {
      await app.close();
    }
  });

  it('channel delete propagates: DELETE → channel.delete enqueued', async () => {
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('channel.delete');
      expect(job.authorUserId).toBe(fx.ownerId);
      const payload = channelDeletePayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.channelId).toBe(fx.channelId);
    } finally {
      await app.close();
    }
  });

  it('no fan-out when server is non-federated (PATCH server)', async () => {
    const fx = await makeFixture({ federationEnabled: false });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Renamed' },
      });
      expect(patch.statusCode).toBe(200);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('no fan-out when server is non-federated (POST/PATCH/DELETE channel)', async () => {
    const fx = await makeFixture({ federationEnabled: false });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);

      const post = await app.inject({
        method: 'POST',
        url: `/api/servers/${fx.serverId}/channels`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: 'text', name: 'no-fed' },
      });
      expect(post.statusCode).toBe(201);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'still-no-fed' },
      });
      expect(patch.statusCode).toBe(200);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);

      // None of the three should have enqueued.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('no fan-out when server is a MIRROR (originInstanceId != null)', async () => {
    // A peer-mirrored server lives here as a read-only reflection of the
    // upstream. Even if a local operator somehow triggers a PATCH (the
    // routes don't gate on this — admin perms are owner-based and the
    // owner is a synthetic remote user), the fan-out MUST NOT fire. A
    // does not push updates for B's mirror back to B.
    const fx = await makeFixture({ isMirror: true });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'should not propagate' },
      });
      expect(patch.statusCode).toBe(200);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('channel.update STILL fans out when PATCH sets federationMode=force_off', async () => {
    // Peers need to learn about the channel going dark — otherwise they
    // would keep expecting messages there. The fan-out gate intentionally
    // checks the SERVER's federation flag (not effective per-channel
    // federation) so a force_off transition still propagates.
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.ownerId);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { federationMode: 'force_off' },
      });
      expect(patch.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('channel.update');
      const payload = channelUpdatePayloadSchema.parse(job.payload);
      expect(payload.channelId).toBe(fx.channelId);
      expect(payload.federationMode).toBe('force_off');
    } finally {
      await app.close();
    }
  });
});
