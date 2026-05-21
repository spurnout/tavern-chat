/**
 * P5-5 — outbound fan-out on dm.message.create.
 *
 * Coverage matrix:
 *   1. Federated 1:1 DM enqueue — alice (local) + bob (remote mirror) share
 *      a DmChannel. Alice posts a message via POST /api/dms/:id/messages.
 *      Exactly ONE `dm.message.create` job is enqueued; payload parses as
 *      `dmMessageCreatePayloadSchema` and carries the qualified author id,
 *      dmChannelId, messageId, content, and ISO createdAt.
 *   2. Local DM no fan-out — alice + dave (both local) DmChannel. Alice
 *      posts a message. No enqueue fires.
 *   3. Group DM with a federated member — 3-person `kind = 'group'` channel
 *      that happens to include a remote mirror user. The local message is
 *      stored; no enqueue fires (Phase 5 limitation).
 *   4. Peer lacks `dms` capability — helper-level. The local DM message
 *      still exists, no envelope is enqueued, and a warning is logged.
 *   5. `federationEnabledOnInstance: false` — defence-in-depth on the
 *      helper. Skips enqueue + warns even if the peer would otherwise
 *      accept.
 *
 * (1)-(3) drive the route via app.inject; (4)-(5) exercise the helper
 * directly with a mock queue. Mirrors the P5-3 test layout so both files
 * read the same way.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  dmMessageCreatePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { fanOutDmMessageCreate } from '../src/services/federation-outbox.js';
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

async function createDirectDmChannel(
  userAId: string,
  userBId: string,
): Promise<string> {
  // The route's findOrCreateDirectDm path also enqueues a `dm.create`
  // (federated case) which would pollute the per-test enqueue assertions.
  // Insert the DmChannel directly so the test only exercises the
  // dm.message.create fan-out.
  const channelId = ulid();
  const sorted = [userAId, userBId].sort();
  await prisma.dmChannel.create({
    data: {
      id: channelId,
      kind: 'direct',
      pairKey: `${sorted[0]}:${sorted[1]}`,
      createdById: userAId,
      members: {
        create: [{ userId: userAId }, { userId: userBId }],
      },
    },
  });
  return channelId;
}

async function createGroupDmChannel(userIds: string[]): Promise<string> {
  const channelId = ulid();
  await prisma.dmChannel.create({
    data: {
      id: channelId,
      kind: 'group',
      name: 'Test group',
      createdById: userIds[0]!,
      members: {
        create: userIds.map((userId) => ({ userId })),
      },
    },
  });
  return channelId;
}

async function cleanDb(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.message.deleteMany({});
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

describe.skipIf(!dockerOk)('P5-5 — fanOutDmMessageCreate helper', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('skips fan-out and warns when peer does NOT advertise the `dms` capability', async () => {
    const peer = await seedPeer('b.example', ['messages']); // no `dms`
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmMessageCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      authorUserId: ulid(),
      authorUsername: 'alice',
      content: 'hi bob',
      replyToMessageId: null,
      createdAt: new Date(),
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmMessageCreate>[0]['log'],
      federationEnabledOnInstance: true,
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find((w) =>
      typeof w.msg === 'string' && w.msg.includes('`dms` capability'),
    );
    expect(matched).toBeDefined();
  });

  it('skips fan-out when federationEnabledOnInstance=false (defence-in-depth)', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmMessageCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      authorUserId: ulid(),
      authorUsername: 'alice',
      content: 'hi bob',
      replyToMessageId: null,
      createdAt: new Date(),
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmMessageCreate>[0]['log'],
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
    // Route-level gate already short-circuits this helper when
    // FEDERATION_DMS_ENABLED=false; this test pins the helper-level
    // defence-in-depth contract so a future caller that forgets the outer
    // guard still gets the right behaviour.
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmMessageCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      authorUserId: ulid(),
      authorUsername: 'alice',
      content: 'hi bob',
      replyToMessageId: null,
      createdAt: new Date(),
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmMessageCreate>[0]['log'],
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

  it('enqueues a parseable dm.message.create payload when peer advertises `dms`', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue, lastJobs } = makeMockQueue();
    const { log } = capturingLogger();
    const dmChannelId = ulid();
    const messageId = ulid();
    const authorUserId = ulid();
    const createdAt = new Date('2026-01-02T03:04:05.000Z');

    await fanOutDmMessageCreate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId,
      messageId,
      authorUserId,
      authorUsername: 'alice',
      content: 'hello, bob',
      replyToMessageId: null,
      createdAt,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmMessageCreate>[0]['log'],
      federationEnabledOnInstance: true,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = lastJobs[0]!;
    expect(job.peerInstanceId).toBe(peer.id);
    expect(job.eventType).toBe('dm.message.create');
    expect(job.messageId).toBe(messageId);
    expect(job.authorUserId).toBe(authorUserId);
    const parsed = dmMessageCreatePayloadSchema.parse(job.payload);
    expect(parsed.dmChannelId).toBe(dmChannelId);
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.authorRemoteUserId).toBe(`alice@${SELF_HOST}`);
    expect(parsed.content).toBe('hello, bob');
    expect(parsed.createdAt).toBe(createdAt.toISOString());
  });
});

// ─── Route-level wire-through ──────────────────────────────────────────────

describe.skipIf(!dockerOk)('P5-5 — POST /api/dms/:id/messages fan-out wiring', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('federates: alice posts in 1:1 DM with remote bob → one `dm.message.create` enqueued', async () => {
    const alice = await createLocalUser('alice');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    // Shared-tavern gate is checked at DM-open time, not on send. We pre-create
    // the DmChannel directly so this test only measures dm.message.create
    // fan-out without the open-time `dm.create` polluting the count.
    await createServerWithMembers(alice.id, [bob.localUserId], {
      federationEnabled: true,
    });
    const dmChannelId = await createDirectDmChannel(alice.id, bob.localUserId);

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
        url: `/api/dms/${dmChannelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hello bob, are you home?' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { data?: { id?: string } };
      const messageId = body.data?.id;
      expect(messageId).toBeTruthy();

      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('dm.message.create');
      expect(job.peerInstanceId).toBe(peer.id);
      expect(job.messageId).toBe(messageId);
      expect(job.authorUserId).toBe(alice.id);
      const parsed = dmMessageCreatePayloadSchema.parse(job.payload);
      expect(parsed.dmChannelId).toBe(dmChannelId);
      expect(parsed.messageId).toBe(messageId);
      expect(parsed.authorRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
      expect(parsed.content).toBe('hello bob, are you home?');
      // createdAt is ISO and parseable.
      expect(() => new Date(parsed.createdAt).toISOString()).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice posts in 1:1 DM with local dave → no enqueue', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');
    await createServerWithMembers(alice.id, [dave.id]);
    const dmChannelId = await createDirectDmChannel(alice.id, dave.id);

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
        url: `/api/dms/${dmChannelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hi dave' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: group DM containing a federated member → no enqueue (Phase 5 limitation)', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    await createServerWithMembers(alice.id, [dave.id, bob.localUserId], {
      federationEnabled: true,
    });
    const dmChannelId = await createGroupDmChannel([alice.id, dave.id, bob.localUserId]);

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
        url: `/api/dms/${dmChannelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hi everyone' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      // Group DM federation is out of scope for Phase 5 — even though bob is
      // a remote mirror, no envelope should fire.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
