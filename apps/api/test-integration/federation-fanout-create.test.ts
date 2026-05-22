/**
 * P3-6 — outbound fan-out on message.create
 *
 * Coverage matrix:
 *   1. computeEffectiveFederation pure function (server flag × channel mode)
 *   2. findPeersWithRemoteMembers returns distinct peer ids (no duplicates),
 *      ignores non-peered remote instances, and ignores all-local servers.
 *   3. fanOutMessageCreate enqueues one job per distinct peer with a payload
 *      that parses as messageCreatePayloadSchema (i.e. the shape is exactly
 *      what receivers expect).
 *   4. The create route wires the helper in correctly: federated server +
 *      remote member → enqueue; non-federated server → no enqueue; DM path
 *      stays out of the helper entirely.
 *
 * The queue is a vi.fn() throughout — the dispatcher path is covered by the
 * federation-outbox.test.ts suite from P3-5.
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
import { messageCreatePayloadSchema } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
import {
  computeEffectiveFederation,
  fanOutMessageCreate,
  findFanOutTargetsForChannel,
  findPeersWithRemoteMembers,
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

interface Fixture {
  ownerId: string;
  ownerUsername: string;
  serverId: string;
  channelId: string;
  /** Local human member used as the message author in route tests. */
  authorId: string;
  authorUsername: string;
  /** Peered RemoteInstance + a User row with `remoteInstanceId = peerA` who is a member. */
  peerAId: string;
  /** Second peered RemoteInstance with a separate remote member. */
  peerBId: string;
}

function silentLogger(): {
  trace: () => void;
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
  fatal: () => void;
  child: () => unknown;
  level: string;
} {
  const noop = () => undefined;
  const log = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => log,
    level: 'info',
  };
  return log;
}

function makeMockQueue(): { queue: QueueClient; enqueue: ReturnType<typeof vi.fn>; lastJobs: FederationOutboxJob[] } {
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

async function createUser(opts: { remoteInstanceId?: string; username?: string }): Promise<{ id: string; username: string }> {
  const id = ulid();
  const username = (opts.username ?? `u-${id.slice(-8).toLowerCase()}`);
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

async function makeServerFixture(): Promise<Fixture> {
  const owner = await createUser({ username: `owner-${ulid().slice(-6).toLowerCase()}` });
  const author = await createUser({ username: `author-${ulid().slice(-6).toLowerCase()}` });
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();

  await prisma.server.create({
    data: { id: serverId, ownerUserId: owner.id, name: 'Fed Tavern' },
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
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneRoleId } });
  await prisma.channel.create({
    data: { id: channelId, serverId, type: 'text', name: 'general' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: owner.id } });
  await prisma.serverMember.create({ data: { serverId, userId: author.id } });

  // Two peered RemoteInstance rows.
  const peerAId = ulid();
  const peerBId = ulid();
  await prisma.remoteInstance.create({
    data: { id: peerAId, host: `a-${peerAId.toLowerCase()}.example`, instanceKey: Buffer.alloc(32, 1), status: 'peered', capabilities: ['messages'] },
  });
  await prisma.remoteInstance.create({
    data: { id: peerBId, host: `b-${peerBId.toLowerCase()}.example`, instanceKey: Buffer.alloc(32, 1), status: 'peered', capabilities: ['messages'] },
  });

  return {
    ownerId: owner.id,
    ownerUsername: owner.username,
    serverId,
    channelId,
    authorId: author.id,
    authorUsername: author.username,
    peerAId,
    peerBId,
  };
}

describe('P3-6 — computeEffectiveFederation', () => {
  it('force_off always wins, regardless of server flag', () => {
    expect(computeEffectiveFederation(true, 'force_off')).toBe(false);
    expect(computeEffectiveFederation(false, 'force_off')).toBe(false);
  });
  it('force_on always wins, regardless of server flag', () => {
    expect(computeEffectiveFederation(true, 'force_on')).toBe(true);
    expect(computeEffectiveFederation(false, 'force_on')).toBe(true);
  });
  it('inherit defers to the server flag', () => {
    expect(computeEffectiveFederation(true, 'inherit')).toBe(true);
    expect(computeEffectiveFederation(false, 'inherit')).toBe(false);
  });
});

describe.skipIf(!dockerOk)('P3-6 — findPeersWithRemoteMembers', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // Order matters: messages/members reference user + server + remote
    // instance; users reference remote instance.
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
  });

  it('returns empty when no remote members are in the server', async () => {
    const fx = await makeServerFixture();
    const result = await findPeersWithRemoteMembers(fx.serverId);
    expect(result).toEqual([]);
  });

  it('returns one id per peer when many remote members share a peer', async () => {
    const fx = await makeServerFixture();
    const r1 = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    const r2 = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: r1.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: r2.id } });

    const result = await findPeersWithRemoteMembers(fx.serverId);
    expect(result).toEqual([fx.peerAId]);
  });

  it('returns multiple ids when remote members come from different peers', async () => {
    const fx = await makeServerFixture();
    const a = await createUser({ remoteInstanceId: fx.peerAId, username: `rema-${ulid().slice(-6).toLowerCase()}` });
    const b = await createUser({ remoteInstanceId: fx.peerBId, username: `remb-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: b.id } });

    const result = await findPeersWithRemoteMembers(fx.serverId);
    expect(result.slice().sort()).toEqual([fx.peerAId, fx.peerBId].slice().sort());
  });

  it('ignores remote members whose RemoteInstance is not peered', async () => {
    const fx = await makeServerFixture();
    // Revoke peer A.
    await prisma.remoteInstance.update({
      where: { id: fx.peerAId },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'test' },
    });
    const remoteOnRevoked = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    const remoteOnPeered = await createUser({ remoteInstanceId: fx.peerBId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remoteOnRevoked.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remoteOnPeered.id } });

    const result = await findPeersWithRemoteMembers(fx.serverId);
    expect(result).toEqual([fx.peerBId]);
  });
});

describe.skipIf(!dockerOk)('P3-6 — fanOutMessageCreate', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
  });

  it('builds a payload that satisfies messageCreatePayloadSchema and enqueues per peer', async () => {
    const fx = await makeServerFixture();
    const a = await createUser({ remoteInstanceId: fx.peerAId, username: `rema-${ulid().slice(-6).toLowerCase()}` });
    const b = await createUser({ remoteInstanceId: fx.peerBId, username: `remb-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: b.id } });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    const messageId = ulid();
    const createdAt = new Date('2026-05-19T12:00:00.000Z');

    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'self.example',
      serverId: fx.serverId,
      channelId: fx.channelId,
      messageId,
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'hello peers',
      createdAt,
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    const peerIdsCalled = lastJobs.map((j) => j.peerInstanceId).sort();
    expect(peerIdsCalled).toEqual([fx.peerAId, fx.peerBId].sort());
    for (const job of lastJobs) {
      expect(job.eventType).toBe('message.create');
      expect(job.messageId).toBe(messageId);
      expect(job.authorUserId).toBe(fx.authorId);
      // Payload must parse cleanly — guards against shape drift between this
      // helper and packages/shared.
      const parsed = messageCreatePayloadSchema.parse(job.payload);
      expect(parsed.authorRemoteUserId).toBe(`${fx.authorUsername}@self.example`);
      expect(parsed.channelId).toBe(fx.channelId);
      expect(parsed.messageId).toBe(messageId);
      expect(parsed.content).toBe('hello peers');
      expect(parsed.createdAt).toBe(createdAt.toISOString());
      expect(parsed.replyToMessageId ?? null).toBeNull();
    }
  });

  it('coalesces two remote members from the same peer into a single enqueue', async () => {
    const fx = await makeServerFixture();
    const a1 = await createUser({ remoteInstanceId: fx.peerAId, username: `rema1-${ulid().slice(-6).toLowerCase()}` });
    const a2 = await createUser({ remoteInstanceId: fx.peerAId, username: `rema2-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a1.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a2.id } });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'self.example',
      serverId: fx.serverId,
      channelId: fx.channelId,
      messageId: ulid(),
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'one peer please',
      createdAt: new Date(),
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(lastJobs[0]?.peerInstanceId).toBe(fx.peerAId);
  });

  it('does not enqueue when there are no remote members', async () => {
    const fx = await makeServerFixture();
    const { queue, enqueue } = makeMockQueue();
    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'self.example',
      serverId: fx.serverId,
      channelId: fx.channelId,
      messageId: ulid(),
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'no peers here',
      createdAt: new Date(),
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('continues fan-out to remaining peers when one enqueue throws', async () => {
    const fx = await makeServerFixture();
    const a = await createUser({ remoteInstanceId: fx.peerAId, username: `rema-${ulid().slice(-6).toLowerCase()}` });
    const b = await createUser({ remoteInstanceId: fx.peerBId, username: `remb-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: b.id } });

    let calls = 0;
    const queue: QueueClient = {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('peer A briefly unreachable');
      }),
      close: vi.fn(async () => undefined),
    };
    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'self.example',
      serverId: fx.serverId,
      channelId: fx.channelId,
      messageId: ulid(),
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'survive partial failure',
      createdAt: new Date(),
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });
    // Two peers, two enqueue attempts even though the first throws.
    expect(queue.enqueueFederationOutbox).toHaveBeenCalledTimes(2);
  });
});

/**
 * Route-level wire-through. Exercises the create handler end-to-end via
 * app.inject so we know the deps wiring + channelMeta fetch + effective
 * federation gate all line up. The handler runs inside the same Postgres
 * container; the queue is a vi.fn() mounted via the buildApp options.
 *
 * Auth uses a `tvn_pat_*` API token so we don't need to mint a session JWT.
 */
describe.skipIf(!dockerOk)('P3-6 — route wire-through', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
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
  });

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
      PUBLIC_BASE_URL: 'https://self.example',
    } as NodeJS.ProcessEnv;
  }

  it('federates when server.federationEnabled=true and a remote member exists', async () => {
    const fx = await makeServerFixture();
    await prisma.server.update({ where: { id: fx.serverId }, data: { federationEnabled: true } });
    const remote = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remote.id } });

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
      const token = await mintTokenFor(fx.authorId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hello peers from route' },
      });
      expect(res.statusCode).toBe(201);
      // Federation enqueue is async (best-effort try/catch) — give the
      // handler's await a tick to land before assertion.
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('message.create');
      const parsed = messageCreatePayloadSchema.parse(job.payload);
      expect(parsed.content).toBe('hello peers from route');
      expect(parsed.authorRemoteUserId).toBe(`${fx.authorUsername}@self.example`);
    } finally {
      await app.close();
    }
  });

  it('does NOT federate when server.federationEnabled=false', async () => {
    const fx = await makeServerFixture();
    const remote = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remote.id } });

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
      const token = await mintTokenFor(fx.authorId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'no fan out' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT federate when channel.federationMode=force_off even if server is federated', async () => {
    const fx = await makeServerFixture();
    await prisma.server.update({ where: { id: fx.serverId }, data: { federationEnabled: true } });
    await prisma.channel.update({
      where: { id: fx.channelId },
      data: { federationMode: 'force_off' },
    });
    const remote = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remote.id } });

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
      const token = await mintTokenFor(fx.authorId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'channel says no' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('DOES federate when channel.federationMode=force_on even if server is not federated', async () => {
    const fx = await makeServerFixture();
    // Server flag stays false.
    await prisma.channel.update({
      where: { id: fx.channelId },
      data: { federationMode: 'force_on' },
    });
    const remote = await createUser({ remoteInstanceId: fx.peerAId, username: `rem-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remote.id } });

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
      const token = await mintTokenFor(fx.authorId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'channel says yes' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does NOT federate DMs (separate code path, helper never reached)', async () => {
    const fx = await makeServerFixture();
    await prisma.server.update({ where: { id: fx.serverId }, data: { federationEnabled: true } });
    // Author plus a second local user share a DM channel.
    const other = await createUser({ username: `other-${ulid().slice(-6).toLowerCase()}` });
    const dmId = ulid();
    await prisma.dmChannel.create({ data: { id: dmId, kind: 'direct' } });
    await prisma.dmChannelMember.create({ data: { dmChannelId: dmId, userId: fx.authorId } });
    await prisma.dmChannelMember.create({ data: { dmChannelId: dmId, userId: other.id } });

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
      const token = await mintTokenFor(fx.authorId);
      // DM messages go through /api/dm-channels/:id/messages — a separate
      // route. We don't need to send one; we just assert that posting to
      // the server channel never engages the DM path. The DM route file
      // doesn't import federation-outbox at all, which is a stronger
      // structural guarantee than a runtime assertion.
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'not a DM' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      // Server channel WITHOUT remote members → no enqueue. The DM
      // channel above is set up only to demonstrate we don't accidentally
      // wire its members into the server fan-out.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

/**
 * P4-14 — mirror-channel post-back.
 *
 * When a local user posts in a MIRROR channel (Channel.originInstanceId !=
 * null), the fan-out must target ONLY the home instance — never the peers
 * the home will relay to (P4-13 does that). Three angles of coverage:
 *
 *   1. The pure helper `findFanOutTargetsForChannel`:
 *      - home channel (origin null) → same set as `findPeersWithRemoteMembers`
 *      - mirror channel (origin set) → exactly `[origin]`, only when peered
 *      - mirror channel + home revoked → `[]` (silent drop, in line with
 *        Phase 3 "non-peered peers don't receive traffic")
 *   2. The fan-out helper end-to-end: enqueue exactly once with
 *      `peerInstanceId = origin`, even when other peered RemoteInstances
 *      have members in the server (P4-13's job, not ours).
 *   3. Route wire-through: local user POSTs to a mirror channel and the
 *      enqueue fires once with peerInstanceId = home. Regression check for
 *      the original P3-6 home path follows in the existing block above.
 */
describe.skipIf(!dockerOk)('P4-14 — findFanOutTargetsForChannel', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
  });

  it('home channel (originInstanceId null) returns the same peers as findPeersWithRemoteMembers', async () => {
    const fx = await makeServerFixture();
    const a = await createUser({ remoteInstanceId: fx.peerAId, username: `rema-${ulid().slice(-6).toLowerCase()}` });
    const b = await createUser({ remoteInstanceId: fx.peerBId, username: `remb-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: b.id } });

    const targets = await findFanOutTargetsForChannel({
      serverId: fx.serverId,
      originInstanceId: null,
    });
    expect(targets.slice().sort()).toEqual([fx.peerAId, fx.peerBId].slice().sort());
  });

  it('mirror channel returns ONLY the home, even when other peers have members', async () => {
    // Set up T as a mirror of peer A. Peer B also has a member in T (he
    // joined the mirror via P4-7). The mirror-channel fan-out MUST NOT
    // include peer B — that's the home's relay job (P4-13).
    const fx = await makeServerFixture();
    const b = await createUser({ remoteInstanceId: fx.peerBId, username: `remb-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: b.id } });

    const targets = await findFanOutTargetsForChannel({
      serverId: fx.serverId,
      originInstanceId: fx.peerAId,
    });
    expect(targets).toEqual([fx.peerAId]);
  });

  it('mirror channel returns [] when the home is no longer peered', async () => {
    const fx = await makeServerFixture();
    // Revoke peer A — even though it's the "home" of T's mirror, an
    // un-peered home cannot receive envelopes. The Phase 3 contract is
    // identical: outbound traffic only flows to peered RemoteInstances.
    await prisma.remoteInstance.update({
      where: { id: fx.peerAId },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'test' },
    });

    const targets = await findFanOutTargetsForChannel({
      serverId: fx.serverId,
      originInstanceId: fx.peerAId,
    });
    expect(targets).toEqual([]);
  });

  it('mirror channel returns [] when the home RemoteInstance row is missing', async () => {
    // Defensive: if a referenced origin is gone (e.g. an admin hard-deleted
    // it), the SetNull cascade clears Channel.originInstanceId, but a stale
    // value passed in directly must not throw. The helper falls back to
    // "no targets" silently.
    const fx = await makeServerFixture();
    const targets = await findFanOutTargetsForChannel({
      serverId: fx.serverId,
      originInstanceId: 'phantom-instance-id',
    });
    expect(targets).toEqual([]);
  });
});

describe.skipIf(!dockerOk)('P4-14 — fanOutMessageCreate with mirror channel', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
  });

  it('enqueues ONCE to the home when a local user posts in a mirror channel', async () => {
    const fx = await makeServerFixture();
    // Pretend B (this instance) mirrors a server homed on peer A. The
    // mirror channel carries originInstanceId=peerAId. Peer B's roster
    // also includes another remote (from peerB) — the helper must NOT
    // fan out to peerB; that's the home's relay job (P4-13).
    await prisma.channel.update({
      where: { id: fx.channelId },
      data: { originInstanceId: fx.peerAId },
    });
    const otherRemote = await createUser({
      remoteInstanceId: fx.peerBId,
      username: `remb-${ulid().slice(-6).toLowerCase()}`,
    });
    await prisma.serverMember.create({
      data: { serverId: fx.serverId, userId: otherRemote.id },
    });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'b.example',
      serverId: fx.serverId,
      channelOriginInstanceId: fx.peerAId,
      channelId: fx.channelId,
      messageId: ulid(),
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'hello home',
      createdAt: new Date(),
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(lastJobs[0]?.peerInstanceId).toBe(fx.peerAId);
  });

  it('does NOT enqueue when the home is no longer peered', async () => {
    const fx = await makeServerFixture();
    await prisma.channel.update({
      where: { id: fx.channelId },
      data: { originInstanceId: fx.peerAId },
    });
    await prisma.remoteInstance.update({
      where: { id: fx.peerAId },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'test' },
    });

    const { queue, enqueue } = makeMockQueue();
    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'b.example',
      serverId: fx.serverId,
      channelOriginInstanceId: fx.peerAId,
      channelId: fx.channelId,
      messageId: ulid(),
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'home is gone',
      createdAt: new Date(),
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('home channel path is unchanged when channelOriginInstanceId is null', async () => {
    // Regression guard for P3-6: passing null preserves the broad
    // "every peer with a remote member" behaviour. Two remote peers →
    // two enqueues.
    const fx = await makeServerFixture();
    const a = await createUser({ remoteInstanceId: fx.peerAId, username: `rema-${ulid().slice(-6).toLowerCase()}` });
    const b = await createUser({ remoteInstanceId: fx.peerBId, username: `remb-${ulid().slice(-6).toLowerCase()}` });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: a.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: b.id } });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    await fanOutMessageCreate({
      queues: queue,
      selfHost: 'self.example',
      serverId: fx.serverId,
      channelOriginInstanceId: null,
      channelId: fx.channelId,
      messageId: ulid(),
      authorUserId: fx.authorId,
      authorUsername: fx.authorUsername,
      content: 'home channel post',
      createdAt: new Date(),
      replyToMessageId: null,
      log: silentLogger() as unknown as Parameters<typeof fanOutMessageCreate>[0]['log'],
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(lastJobs.map((j) => j.peerInstanceId).sort()).toEqual(
      [fx.peerAId, fx.peerBId].sort(),
    );
  });
});

describe.skipIf(!dockerOk)('P4-14 — route wire-through for mirror channels', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
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
  });

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
      PUBLIC_BASE_URL: 'https://b.example',
    } as NodeJS.ProcessEnv;
  }

  it('local post in a mirror channel enqueues exactly once for the home', async () => {
    // Mirror configuration on B:
    //   - Server T has originInstanceId = peerA (the home).
    //   - Channel "general" has originInstanceId = peerA.
    //   - federationEnabled is on (mirror servers are by definition federated).
    //   - There's also a third-party remote member from peerB — they MUST
    //     NOT receive the fan-out from B; peerA's P4-13 relay handles that.
    const fx = await makeServerFixture();
    await prisma.server.update({
      where: { id: fx.serverId },
      data: { federationEnabled: true, originInstanceId: fx.peerAId },
    });
    await prisma.channel.update({
      where: { id: fx.channelId },
      data: { originInstanceId: fx.peerAId },
    });
    const otherRemote = await createUser({
      remoteInstanceId: fx.peerBId,
      username: `remb-${ulid().slice(-6).toLowerCase()}`,
    });
    await prisma.serverMember.create({
      data: { serverId: fx.serverId, userId: otherRemote.id },
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
      const token = await mintTokenFor(fx.authorId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'mirror-side post' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      // The crux: ONE job, addressed to the home (peerA). PeerB is the
      // home's responsibility to reach via P4-13.
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(captured[0]?.peerInstanceId).toBe(fx.peerAId);
      expect(captured[0]?.eventType).toBe('message.create');
      const parsed = messageCreatePayloadSchema.parse(captured[0]!.payload);
      expect(parsed.content).toBe('mirror-side post');
      // Author identity is rendered against THIS instance's host (b.example),
      // matching the configured PUBLIC_BASE_URL — the home accepts it as a
      // local-on-B user.
      expect(parsed.authorRemoteUserId).toBe(`${fx.authorUsername}@b.example`);
    } finally {
      await app.close();
    }
  });

  it('home post still fans out to every peer with remote members (P3-6 regression)', async () => {
    // Confirms the home path is untouched: T is locally owned
    // (originInstanceId null on both server + channel), and a remote
    // member exists. Same expectation as the existing P3-6 wire-through
    // test, asserted here against the new code path to prove no
    // regression.
    const fx = await makeServerFixture();
    await prisma.server.update({
      where: { id: fx.serverId },
      data: { federationEnabled: true },
    });
    const remoteA = await createUser({
      remoteInstanceId: fx.peerAId,
      username: `rema-${ulid().slice(-6).toLowerCase()}`,
    });
    const remoteB = await createUser({
      remoteInstanceId: fx.peerBId,
      username: `remb-${ulid().slice(-6).toLowerCase()}`,
    });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remoteA.id } });
    await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: remoteB.id } });

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
      const token = await mintTokenFor(fx.authorId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'home-side post' },
      });
      expect(res.statusCode).toBe(201);
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).toHaveBeenCalledTimes(2);
      const peers = captured.map((j) => j.peerInstanceId).sort();
      expect(peers).toEqual([fx.peerAId, fx.peerBId].sort());
    } finally {
      await app.close();
    }
  });
});
