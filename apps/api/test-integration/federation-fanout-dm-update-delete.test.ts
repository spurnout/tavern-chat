/**
 * P5-7 — outbound fan-out on dm.message.update + dm.message.delete.
 *
 * Mirrors the layout of `federation-fanout-dm-message-create.test.ts`
 * exactly so both files read the same way.
 *
 * Coverage matrix:
 *   1. Federated 1:1 DM, PATCH — alice (local) + bob (remote) share a
 *      DmChannel. Alice edits her message. Exactly ONE
 *      `dm.message.update` job is enqueued; the payload parses as
 *      `dmMessageUpdatePayloadSchema` and carries the qualified author id,
 *      dmChannelId, messageId, new content, and ISO editedAt.
 *   2. Local DM, PATCH — alice + dave (both local) DmChannel. Alice edits.
 *      No enqueue fires.
 *   3. Federated 1:1 DM, DELETE — same setup as (1), alice deletes her
 *      own message. Exactly ONE `dm.message.delete` job is enqueued.
 *   4. Local DM, DELETE — alice + dave delete. No enqueue.
 *   5. Group DM with one remote member, PATCH — alice + dave + bob (remote)
 *      in a `kind = 'group'` channel. Alice edits. No enqueue (Phase 5
 *      group-DM federation is out of scope).
 *
 * (1)-(5) drive the route via app.inject with a mock queue capturing
 * enqueueFederationOutbox calls. Helper-level capability / defence-in-depth
 * gates already have coverage in the create-side suite — they're the
 * same code path for update/delete here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  dmMessageDeletePayloadSchema,
  dmMessageUpdatePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
import {
  fanOutDmMessageDelete,
  fanOutDmMessageUpdate,
} from '../src/services/federation-outbox.js';
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

async function createDirectDmChannel(userAId: string, userBId: string): Promise<string> {
  const channelId = ulid();
  const sorted = [userAId, userBId].sort();
  await prisma.dmChannel.create({
    data: {
      id: channelId,
      kind: 'direct',
      pairKey: `${sorted[0]}:${sorted[1]}`,
      createdById: userAId,
      members: { create: [{ userId: userAId }, { userId: userBId }] },
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
      members: { create: userIds.map((userId) => ({ userId })) },
    },
  });
  return channelId;
}

/**
 * Insert a DM Message row directly. We don't go through POST
 * /api/dms/:id/messages because that fires its OWN dm.message.create
 * fan-out which would pollute the enqueue counts. The PATCH / DELETE
 * routes only care that the row exists.
 */
async function seedDmMessage(opts: {
  dmChannelId: string;
  authorId: string;
  content: string;
}): Promise<string> {
  const messageId = ulid();
  await prisma.message.create({
    data: {
      id: messageId,
      dmChannelId: opts.dmChannelId,
      authorId: opts.authorId,
      type: 'default',
      content: opts.content,
    },
  });
  return messageId;
}

async function cleanDb(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.messageEdit.deleteMany({});
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
  // Each buildApp call provisions a fresh FederationKey with a random
  // TAVERN_DATA_KEY (see envFor). Drop existing rows so bootstrap doesn't
  // try to decrypt with last test's data key.
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

function envFor(dbUrl: string, federationEnabled: boolean): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: federationEnabled ? 'true' : 'false',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

// ─── PATCH /api/messages/:id ────────────────────────────────────────────────

describe.skipIf(!dockerOk)('P5-7 — PATCH /api/messages/:id DM fan-out wiring', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('federates: alice edits her DM message to remote bob → one `dm.message.update` enqueued', async () => {
    const alice = await createLocalUser('alice');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    await createServerWithMembers(alice.id, [bob.localUserId], { federationEnabled: true });
    const dmChannelId = await createDirectDmChannel(alice.id, bob.localUserId);
    const messageId = await seedDmMessage({
      dmChannelId,
      authorId: alice.id,
      content: 'hello bob',
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
        method: 'PATCH',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hello bob, did you bring the dice?' },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('dm.message.update');
      expect(job.peerInstanceId).toBe(peer.id);
      expect(job.messageId).toBe(messageId);
      expect(job.authorUserId).toBe(alice.id);
      const parsed = dmMessageUpdatePayloadSchema.parse(job.payload);
      expect(parsed.dmChannelId).toBe(dmChannelId);
      expect(parsed.messageId).toBe(messageId);
      expect(parsed.authorRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
      expect(parsed.content).toBe('hello bob, did you bring the dice?');
      expect(() => new Date(parsed.editedAt).toISOString()).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice edits her DM message to local dave → no enqueue', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');
    await createServerWithMembers(alice.id, [dave.id]);
    const dmChannelId = await createDirectDmChannel(alice.id, dave.id);
    const messageId = await seedDmMessage({
      dmChannelId,
      authorId: alice.id,
      content: 'hi dave',
    });

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
        method: 'PATCH',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hi dave (edited)' },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice edits her message in a group DM containing remote bob → no enqueue', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    await createServerWithMembers(alice.id, [dave.id, bob.localUserId], {
      federationEnabled: true,
    });
    const dmChannelId = await createGroupDmChannel([alice.id, dave.id, bob.localUserId]);
    const messageId = await seedDmMessage({
      dmChannelId,
      authorId: alice.id,
      content: 'hi everyone',
    });

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
        method: 'PATCH',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hi everyone (edit)' },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ─── DELETE /api/messages/:id ───────────────────────────────────────────────

describe.skipIf(!dockerOk)('P5-7 — DELETE /api/messages/:id DM fan-out wiring', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('federates: alice deletes her DM message to remote bob → one `dm.message.delete` enqueued', async () => {
    const alice = await createLocalUser('alice');
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const bob = await createRemoteUserMirror(peer, 'bob');
    await createServerWithMembers(alice.id, [bob.localUserId], { federationEnabled: true });
    const dmChannelId = await createDirectDmChannel(alice.id, bob.localUserId);
    const messageId = await seedDmMessage({
      dmChannelId,
      authorId: alice.id,
      content: 'whoops, retracted',
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
        method: 'DELETE',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('dm.message.delete');
      expect(job.peerInstanceId).toBe(peer.id);
      expect(job.messageId).toBe(messageId);
      expect(job.authorUserId).toBe(alice.id);
      const parsed = dmMessageDeletePayloadSchema.parse(job.payload);
      expect(parsed.dmChannelId).toBe(dmChannelId);
      expect(parsed.messageId).toBe(messageId);
      expect(parsed.actorRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
      expect(() => new Date(parsed.deletedAt).toISOString()).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice deletes her DM message to local dave → no enqueue', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');
    await createServerWithMembers(alice.id, [dave.id]);
    const dmChannelId = await createDirectDmChannel(alice.id, dave.id);
    const messageId = await seedDmMessage({
      dmChannelId,
      authorId: alice.id,
      content: 'nvm',
    });

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
        method: 'DELETE',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ─── Helper-level defence-in-depth tests ────────────────────────────────────
//
// Mirror the test in `federation-fanout-dm-message-create.test.ts`: the route
// already guards on `FEDERATION_DMS_ENABLED=false`, but the helper must
// also refuse to enqueue if a future caller forgets the outer gate.

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
} {
  const enqueue = vi.fn(async (_job: FederationOutboxJob) => undefined);
  const queue: QueueClient = {
    enqueueScan: vi.fn(async () => undefined),
    enqueueFederationOutbox: enqueue,
    close: vi.fn(async () => undefined),
  };
  return { queue, enqueue };
}

describe.skipIf(!dockerOk)('P5-7 — helper defence-in-depth (FEDERATION_DMS_ENABLED)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('fanOutDmMessageUpdate: skips fan-out when federationDmsEnabledOnInstance=false', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmMessageUpdate({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      authorUserId: ulid(),
      authorUsername: 'alice',
      content: 'edited',
      editedAt: new Date(),
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmMessageUpdate>[0]['log'],
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

  it('fanOutDmMessageDelete: skips fan-out when federationDmsEnabledOnInstance=false', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmMessageDelete({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      actorUserId: ulid(),
      actorUsername: 'alice',
      deletedAt: new Date(),
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmMessageDelete>[0]['log'],
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
});
