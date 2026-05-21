/**
 * P5-9 — outbound fan-out on dm.reaction.add + dm.reaction.remove.
 *
 * Mirrors the layout of `federation-fanout-dm-update-delete.test.ts`
 * exactly so all DM federation tests read the same way.
 *
 * Coverage matrix:
 *   1. Federated 1:1 DM, PUT — alice (local) + bob (remote) share a
 *      DmChannel. Alice reacts to her own message. Exactly ONE
 *      `dm.reaction.add` job is enqueued; the payload parses as
 *      `dmReactionAddPayloadSchema` and carries the qualified actor id,
 *      dmChannelId, messageId, and emoji.
 *   2. Federated 1:1 DM, DELETE — same setup as (1), alice removes her
 *      reaction. Exactly ONE `dm.reaction.remove` job is enqueued.
 *   3. Local DM, PUT — alice + dave (both local) DmChannel. Alice reacts.
 *      No enqueue fires.
 *   4. Group DM with one remote member, PUT — alice + dave + bob (remote)
 *      in a `kind = 'group'` channel. Alice reacts. No enqueue (Phase 5
 *      group-DM federation is out of scope).
 *   5. Peer lacks `dms` capability — federated 1:1 DM, but the peer's
 *      capabilities don't include `dms`. No enqueue (the helper's
 *      capability gate fires).
 *   6. Instance-level FEDERATION_ENABLED=false — defence-in-depth gate
 *      inside the helper short-circuits even when the wiring would
 *      otherwise fire. No enqueue.
 *
 * (1)-(6) drive the route via app.inject with a mock queue capturing
 * enqueueFederationOutbox calls. Helper-level dispatch is covered by the
 * federation-outbox unit suite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  dmReactionAddPayloadSchema,
  dmReactionRemovePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import {
  fanOutDmReactionAdd,
  fanOutDmReactionRemove,
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
const EMOJI = '👍';

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
 * fan-out which would pollute the enqueue counts.
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
  await prisma.messageReaction.deleteMany({});
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
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

// ─── PUT /api/messages/:id/reactions/:emoji ─────────────────────────────────

describe.skipIf(!dockerOk)('P5-9 — PUT reaction DM fan-out wiring', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('federates: alice reacts to her DM message to remote bob → one `dm.reaction.add` enqueued', async () => {
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
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('dm.reaction.add');
      expect(job.peerInstanceId).toBe(peer.id);
      expect(job.messageId).toBe(messageId);
      expect(job.authorUserId).toBe(alice.id);
      const parsed = dmReactionAddPayloadSchema.parse(job.payload);
      expect(parsed.dmChannelId).toBe(dmChannelId);
      expect(parsed.messageId).toBe(messageId);
      expect(parsed.actorRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
      expect(parsed.emoji).toBe(EMOJI);
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice reacts to her DM message to local dave → no enqueue', async () => {
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
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice reacts in a group DM containing remote bob → no enqueue', async () => {
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
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: peer lacks the `dms` capability → no enqueue', async () => {
    const alice = await createLocalUser('alice');
    // Peer only advertises `messages`, not `dms`. The helper's capability
    // gate fires and short-circuits the enqueue.
    const peer = await seedPeer('b.example', ['messages']);
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
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: FEDERATION_ENABLED=false on the instance → no enqueue (defence-in-depth)', async () => {
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
    const enqueue = vi.fn(async () => undefined);
    // FEDERATION_ENABLED=false on this instance. The route layer's outer
    // gate already short-circuits, but the helper's defence-in-depth gate
    // would ALSO block the enqueue if reached.
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, false)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(alice.id);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
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

// ─── DELETE /api/messages/:id/reactions/:emoji ──────────────────────────────

describe.skipIf(!dockerOk)('P5-9 — DELETE reaction DM fan-out wiring', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('federates: alice removes her reaction on DM with remote bob → one `dm.reaction.remove` enqueued', async () => {
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
      // Add the reaction first so the DELETE has something to remove.
      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();
      captured.length = 0;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('dm.reaction.remove');
      expect(job.peerInstanceId).toBe(peer.id);
      expect(job.messageId).toBe(messageId);
      expect(job.authorUserId).toBe(alice.id);
      const parsed = dmReactionRemovePayloadSchema.parse(job.payload);
      expect(parsed.dmChannelId).toBe(dmChannelId);
      expect(parsed.messageId).toBe(messageId);
      expect(parsed.actorRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
      expect(parsed.emoji).toBe(EMOJI);
    } finally {
      await app.close();
    }
  });

  it('does NOT federate: alice removes her reaction on a local DM with dave → no enqueue', async () => {
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
      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent(EMOJI)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
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

describe.skipIf(!dockerOk)('P5-9 — helper defence-in-depth (FEDERATION_DMS_ENABLED)', () => {
  it('fanOutDmReactionAdd: skips fan-out when federationDmsEnabledOnInstance=false', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmReactionAdd({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      actorUserId: ulid(),
      actorUsername: 'alice',
      emoji: EMOJI,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmReactionAdd>[0]['log'],
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

  it('fanOutDmReactionRemove: skips fan-out when federationDmsEnabledOnInstance=false', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']);
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutDmReactionRemove({
      queues: queue,
      selfHost: SELF_HOST,
      dmChannelId: ulid(),
      messageId: ulid(),
      actorUserId: ulid(),
      actorUsername: 'alice',
      emoji: EMOJI,
      peerInstanceId: peer.id,
      log: log as unknown as Parameters<typeof fanOutDmReactionRemove>[0]['log'],
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
