/**
 * P5-3 — outbound fan-out on dm.create.
 *
 * Coverage matrix:
 *   1. Federated DM enqueue — alice (local) opens a DM with bob (remote
 *      mirror, peer advertises `dms`). The route enqueues exactly one
 *      `dm.create` job; the payload parses as `dmCreatePayloadSchema`
 *      and carries the qualified ids + the local dmChannelId.
 *   2. Local DM no fan-out — alice opens a DM with dave (local). The
 *      DM is created, but no enqueue fires.
 *   3. Peer lacks `dms` capability — peer is peered for `messages` only.
 *      The local DmChannel still exists, no envelope is enqueued, and a
 *      warning is logged describing the missing capability.
 *   4. Peer not peered — peer.status = 'revoked'. Same expectation as
 *      (3): no enqueue, warning logged.
 *   5. `federationEnabledOnInstance` defence-in-depth — passing false to
 *      the helper directly short-circuits with a warning, even if the
 *      peer would otherwise accept the envelope.
 *
 * Tests (1) and (2) exercise the full route via app.inject; (3)–(5)
 * exercise the helper directly with a mock queue. This mirrors the
 * P3-6 / P4-14 structure for fanOutMessageCreate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  dmCreatePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { fanOutDmCreate } from '../src/services/federation-outbox.js';
import type { QueueClient } from '../src/services/queues.js';
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

interface CapturingLogger {
  warnCalls: Array<{ obj: unknown; msg: string }>;
  log: {
    trace: () => void;
    debug: () => void;
    info: () => void;
    warn: (obj: unknown, msg: string) => void;
    error: () => void;
    fatal: () => void;
    child: () => unknown;
    level: string;
  };
}

function capturingLogger(): CapturingLogger {
  const warnCalls: CapturingLogger['warnCalls'] = [];
  const noop = () => undefined;
  const log = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (obj: unknown, msg: string) => {
      warnCalls.push({ obj, msg });
    },
    error: noop,
    fatal: noop,
    child: () => log,
    level: 'info',
  };
  return { warnCalls, log };
}

function makeMockQueue(): {
  queue: QueueClient;
  enqueue: ReturnType<typeof vi.fn>;
  lastJobs: FederationOutboxJob[];
} {
  const lastJobs: FederationOutboxJob[] = [];
  const enqueue = vi.fn(async (job: FederationOutboxJob) => {
    lastJobs.push(job);
  });
  const queue: QueueClient = {
    enqueueScan: vi.fn(async () => undefined),
    enqueueFederationOutbox: enqueue,
    close: vi.fn(async () => undefined),
  };
  return { queue, enqueue, lastJobs };
}

async function createLocalUser(prefix: string): Promise<{ id: string; username: string }> {
  const id = ulid();
  const username = `${prefix}-${id.toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username,
      usernameLower: username,
      displayName: prefix,
      email: `${id.toLowerCase()}@${SELF_HOST}`,
      emailLower: `${id.toLowerCase()}@${SELF_HOST}`,
      passwordHash: 'x',
    },
  });
  return { id, username };
}

async function seedPeer(
  host: string,
  capabilities: string[],
  status: 'peered' | 'revoked' | 'pending_inbound' | 'pending_outbound' | 'blocked' = 'peered',
): Promise<{ id: string; host: string }> {
  const id = ulid();
  await prisma.remoteInstance.create({
    data: {
      id,
      host,
      instanceKey: randomBytes(32),
      status,
      capabilities,
      ...(status === 'peered' ? { peeredAt: new Date() } : {}),
    },
  });
  return { id, host };
}

async function createRemoteUserMirror(
  peer: { id: string; host: string },
  localpart: string,
): Promise<{ localUserId: string; remoteUserId: string }> {
  const qualified = `${localpart}@${peer.host}`;
  const remoteUserRowId = ulid();
  const localUserId = ulid();
  const syntheticUsername = `__rem_${localUserId.toLowerCase()}`;
  await prisma.remoteUser.create({
    data: {
      id: remoteUserRowId,
      remoteInstanceId: peer.id,
      remoteUserId: qualified,
      displayNameCache: localpart,
      avatarUrlCache: null,
      publicKey: randomBytes(32),
    },
  });
  await prisma.user.create({
    data: {
      id: localUserId,
      username: syntheticUsername,
      usernameLower: syntheticUsername,
      displayName: localpart,
      email: `${localUserId.toLowerCase()}@${peer.host}.federated.local`,
      emailLower: `${localUserId.toLowerCase()}@${peer.host}.federated.local`,
      passwordHash: null,
      remoteUserId: qualified,
      remoteInstanceId: peer.id,
    },
  });
  return { localUserId, remoteUserId: qualified };
}

async function createServerWithMembers(
  ownerId: string,
  memberIds: string[],
  opts?: { federationEnabled?: boolean },
): Promise<string> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: ownerId,
      name: 'Test Tavern',
      federationEnabled: opts?.federationEnabled ?? false,
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
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  for (const uid of memberIds) {
    if (uid === ownerId) continue;
    await prisma.serverMember.create({ data: { serverId, userId: uid } });
  }
  return serverId;
}

async function cleanDb(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMemberRole.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
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

function envFor(dbUrl: string, federationEnabled: boolean): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: federationEnabled ? 'true' : 'false',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

// ─── Helper-level tests (no app boot) ───────────────────────────────────────

describe.skipIf(!dockerOk)('P5-3 — fanOutDmCreate helper', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('skips fan-out and warns when peer does NOT advertise the `dms` capability', async () => {
    const peer = await seedPeer('b.example', ['messages']); // no `dms`
    const bob = await createRemoteUserMirror(peer, 'bob');
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      initiatorUserId: ulid(),
      initiatorUsername: 'alice',
      recipientRemoteUserId: bob.remoteUserId,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmCreate>[0]['log'],
      federationEnabledOnInstance: true,
    });

    expect(enqueue).not.toHaveBeenCalled();
    // The warn must mention the missing capability so an operator can spot
    // a misconfigured peer.
    const matched = warnCalls.find((w) =>
      typeof w.msg === 'string' && w.msg.includes('`dms` capability'),
    );
    expect(matched).toBeDefined();
  });

  it('skips fan-out and warns when peer is NOT peered', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms'], 'revoked');
    const bob = await createRemoteUserMirror(peer, 'bob');
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      initiatorUserId: ulid(),
      initiatorUsername: 'alice',
      recipientRemoteUserId: bob.remoteUserId,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmCreate>[0]['log'],
      federationEnabledOnInstance: true,
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find((w) =>
      typeof w.msg === 'string' && w.msg.includes('peer is not peered'),
    );
    expect(matched).toBeDefined();
  });

  it('skips fan-out when federationEnabledOnInstance=false (defence-in-depth)', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      initiatorUserId: ulid(),
      initiatorUsername: 'alice',
      recipientRemoteUserId: bob.remoteUserId,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmCreate>[0]['log'],
      federationEnabledOnInstance: false,
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find((w) =>
      typeof w.msg === 'string' &&
        w.msg.includes('FEDERATION_ENABLED=false') &&
        w.msg.includes('defence-in-depth'),
    );
    expect(matched).toBeDefined();
  });

  it('skips fan-out when federationDmsEnabledOnInstance=false (defence-in-depth)', async () => {
    // The route-level gate at `routes/dms.ts` already short-circuits this
    // helper when FEDERATION_DMS_ENABLED=false, but if a future caller forgets
    // the outer guard the helper itself must still refuse to enqueue. Mirror
    // the FEDERATION_ENABLED=false test above — peer would otherwise accept.
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      initiatorUserId: ulid(),
      initiatorUsername: 'alice',
      recipientRemoteUserId: bob.remoteUserId,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmCreate>[0]['log'],
      federationEnabledOnInstance: true,
      federationDmsEnabledOnInstance: false,
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find((w) =>
      typeof w.msg === 'string' &&
        w.msg.includes('FEDERATION_DMS_ENABLED=false') &&
        w.msg.includes('defence-in-depth'),
    );
    expect(matched).toBeDefined();
  });

  it('enqueues a parseable dm.create payload when the peer advertises `dms`', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    const { queue, enqueue, lastJobs } = makeMockQueue();
    const { log } = capturingLogger();
    const dmChannelId = ulid();
    const initiatorUserId = ulid();

    await fanOutDmCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId,
      initiatorUserId,
      initiatorUsername: 'alice',
      recipientRemoteUserId: bob.remoteUserId,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmCreate>[0]['log'],
      federationEnabledOnInstance: true,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = lastJobs[0]!;
    expect(job.peerInstanceId).toBe(peer.id);
    expect(job.eventType).toBe('dm.create');
    expect(job.messageId).toBe(dmChannelId);
    expect(job.authorUserId).toBe(initiatorUserId);
    const parsed = dmCreatePayloadSchema.parse(job.payload);
    expect(parsed.dmChannelId).toBe(dmChannelId);
    expect(parsed.initiatorRemoteUserId).toBe(`alice@${SELF_HOST}`);
    expect(parsed.recipientRemoteUserId).toBe(bob.remoteUserId);
    // createdAt is ISO + parseable.
    expect(() => new Date(parsed.createdAt).toISOString()).not.toThrow();
  });
});

// ─── Route-level wire-through ──────────────────────────────────────────────

describe.skipIf(!dockerOk)('P5-3 — POST /api/dms/direct fan-out wiring', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('federates: alice opens DM with remote bob → one `dm.create` enqueued', async () => {
    const alice = await createLocalUser('alice');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    // Shared-tavern gate: alice + bob must share a server to open a DM.
    await createServerWithMembers(alice.id, [bob.localUserId], {
      federationEnabled: true,
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, true)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(alice.id);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: bob.localUserId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data?: { id?: string } };
      const dmChannelId = body.data?.id;
      expect(dmChannelId).toBeTruthy();

      // The fan-out is awaited inside the handler before reply.send(), so by
      // the time we get here the enqueue has either fired or the helper
      // returned. Still tick for symmetry with the message tests.
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('dm.create');
      expect(job.peerInstanceId).toBe(peer.id);
      expect(job.messageId).toBe(dmChannelId);
      const parsed = dmCreatePayloadSchema.parse(job.payload);
      expect(parsed.dmChannelId).toBe(dmChannelId);
      expect(parsed.initiatorRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
      expect(parsed.recipientRemoteUserId).toBe(bob.remoteUserId);
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice opens DM with local dave → no enqueue', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');
    await createServerWithMembers(alice.id, [dave.id]);

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, true)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(alice.id);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: dave.id },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('idempotent re-create: second open still enqueues a `dm.create` for the same dmChannelId', async () => {
    const alice = await createLocalUser('alice');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    await createServerWithMembers(alice.id, [bob.localUserId], {
      federationEnabled: true,
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, true)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(alice.id);
      const first = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: bob.localUserId },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: bob.localUserId },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstId = (first.json() as { data?: { id?: string } }).data?.id;
      const secondId = (second.json() as { data?: { id?: string } }).data?.id;
      // findOrCreateDirectDm is idempotent — same id both times.
      expect(secondId).toBe(firstId);

      await new Promise<void>((r) => setTimeout(r, 50));
      // Both opens fan out `dm.create`. The peer-side handler is the one
      // responsible for collapsing them; the source instance does not try
      // to be clever.
      expect(enqueue).toHaveBeenCalledTimes(2);
      for (const job of captured) {
        expect(job.eventType).toBe('dm.create');
        expect(job.messageId).toBe(firstId);
        expect(job.peerInstanceId).toBe(peer.id);
      }
    } finally {
      await app.close();
    }
  });
});
