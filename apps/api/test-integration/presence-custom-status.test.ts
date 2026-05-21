/**
 * P6-8 — custom status get / set / clear via PATCH /api/me/presence.
 *
 * Coverage:
 *   1. Service-level: `setCustomStatus` persists status + expiresAt,
 *      advances `presenceUpdatedAt`, broadcasts PRESENCE_UPDATE locally,
 *      and schedules an IMMEDIATE fan-out (no debounce wait).
 *   2. Service-level: `clearCustomStatus` zeroes both fields, broadcasts,
 *      schedules immediate fan-out.
 *   3. Service-level: `setCustomStatus` with no expiry → row's
 *      `customStatusExpiresAt` stays null while `customStatus` is stored.
 *   4. Route-level: `PATCH /api/me/presence` with `customStatusExpiresAt`
 *      in the past → 400 `custom_status_expires_in_past`, no DB write.
 *   5. Route-level: `GET /api/me/presence` returns `customStatus` +
 *      `customStatusExpiresAt` alongside presence + manualDnd.
 *
 * Docker-gated skip pattern matches the rest of the integration suite.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ulid } from '@tavern/shared';
import type { FederationOutboxJob } from '@tavern/federation';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';
import { gatewayBroker } from '../src/services/gateway-broker.js';
import {
  __testResetPresenceState,
  clearCustomStatus,
  configurePresenceFederation,
  setCustomStatus,
} from '../src/services/presence-service.js';
import type { QueueClient } from '../src/services/queues.js';

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
  log: {
    trace: () => void;
    debug: () => void;
    info: () => void;
    warn: () => void;
    error: () => void;
    fatal: () => void;
    child: () => unknown;
    level: string;
  };
}

function capturingLogger(): CapturingLogger {
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
  return { log };
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
  capabilities: string[] = ['messages', 'dms', 'presence'],
): Promise<{ id: string; host: string }> {
  const id = ulid();
  await prisma.remoteInstance.create({
    data: {
      id,
      host,
      instanceKey: randomBytes(32),
      status: 'peered',
      capabilities,
      peeredAt: new Date(),
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
  opts: { federationEnabled: boolean },
): Promise<string> {
  const serverId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: ownerId,
      name: `Tavern-${serverId}`,
      federationEnabled: opts.federationEnabled,
    },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  for (const uid of memberIds) {
    if (uid === ownerId) continue;
    await prisma.serverMember.create({ data: { serverId, userId: uid } });
  }
  return serverId;
}

async function cleanDb(): Promise<void> {
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
}

// ─── Service-level tests ──────────────────────────────────────────────────

describe.skipIf(!dockerOk)('P6-8 — setCustomStatus / clearCustomStatus service', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    __testResetPresenceState();
    await cleanDb();
  });

  afterEach(() => {
    if (!dockerOk) return;
    __testResetPresenceState();
    configurePresenceFederation(null);
  });

  it('persists customStatus + customStatusExpiresAt, advances watermark, broadcasts, fans out immediately', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const before = await prisma.user.findUnique({
      where: { id: alice.id },
      select: { presenceUpdatedAt: true },
    });
    const watermarkBefore = before?.presenceUpdatedAt?.getTime() ?? 0;

    const { queue, enqueue } = makeMockQueue();
    const cap = capturingLogger();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: cap.log as never,
    });

    const events: Array<{ type: string; userId?: string; data: unknown }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) =>
      events.push({
        type: e.type,
        userId: e.userId,
        data: e.data,
      }),
    );

    try {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // +1h
      await setCustomStatus(alice.id, 'In a session', expiresAt);

      // Row updated.
      const row = await prisma.user.findUnique({
        where: { id: alice.id },
        select: {
          customStatus: true,
          customStatusExpiresAt: true,
          presenceUpdatedAt: true,
        },
      });
      expect(row?.customStatus).toBe('In a session');
      expect(row?.customStatusExpiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(row?.presenceUpdatedAt.getTime()).toBeGreaterThan(watermarkBefore);

      // Broadcast fired with PRESENCE_UPDATE for the user.
      const evt = events.find(
        (e) => e.type === 'PRESENCE_UPDATE' && e.userId === alice.id,
      );
      expect(evt).toBeDefined();

      // Immediate fan-out — no debounce drain needed. The setTimeout(0)-style
      // emitFanOut goes through one microtask + a DB read; give it a couple
      // of ticks to settle.
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = enqueue.mock.calls[0]![0] as FederationOutboxJob;
      expect(job.eventType).toBe('presence.update');
      expect(job.peerInstanceId).toBe(peerB.id);
    } finally {
      unsubscribe();
    }
  });

  it('clearCustomStatus zeroes both fields, broadcasts, fans out immediately', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    // Pre-seed a status so clear has something to remove.
    await prisma.user.update({
      where: { id: alice.id },
      data: {
        customStatus: 'pre-existing',
        customStatusExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const { queue, enqueue } = makeMockQueue();
    const cap = capturingLogger();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: cap.log as never,
    });

    const events: Array<{ type: string; userId?: string; data: unknown }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) =>
      events.push({
        type: e.type,
        userId: e.userId,
        data: e.data,
      }),
    );

    try {
      await clearCustomStatus(alice.id);

      const row = await prisma.user.findUnique({
        where: { id: alice.id },
        select: { customStatus: true, customStatusExpiresAt: true },
      });
      expect(row?.customStatus).toBeNull();
      expect(row?.customStatusExpiresAt).toBeNull();

      const evt = events.find(
        (e) => e.type === 'PRESENCE_UPDATE' && e.userId === alice.id,
      );
      expect(evt).toBeDefined();

      await new Promise<void>((r) => setTimeout(r, 50));
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('setCustomStatus with null expiresAt stores status but leaves expiresAt null', async () => {
    const alice = await createLocalUser('alice');

    const { queue } = makeMockQueue();
    const cap = capturingLogger();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: cap.log as never,
    });

    await setCustomStatus(alice.id, 'no expiry', null);

    const row = await prisma.user.findUnique({
      where: { id: alice.id },
      select: { customStatus: true, customStatusExpiresAt: true },
    });
    expect(row?.customStatus).toBe('no expiry');
    expect(row?.customStatusExpiresAt).toBeNull();
  });

  it('no-op when the user row is missing (defensive)', async () => {
    const { queue, enqueue } = makeMockQueue();
    const cap = capturingLogger();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: cap.log as never,
    });

    await expect(
      setCustomStatus('user-that-does-not-exist', 'oops', null),
    ).resolves.toBeUndefined();
    await expect(
      clearCustomStatus('user-that-does-not-exist'),
    ).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ─── Route-level tests ────────────────────────────────────────────────────

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

async function makeUserWithToken(prefix: string): Promise<{
  userId: string;
  username: string;
  token: string;
}> {
  const userId = ulid();
  const sessionId = ulid();
  const username = `${prefix}-${userId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@${SELF_HOST}`,
      emailLower: `${username}@${SELF_HOST}`,
      passwordHash: 'x',
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
  const jwt = new JwtService({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 7,
  });
  const { token } = await jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });
  return { userId, username, token };
}

describe.skipIf(!dockerOk)('P6-8 — PATCH/GET /api/me/presence custom status', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    __testResetPresenceState();
    await cleanDb();
  });

  afterEach(() => {
    if (!dockerOk) return;
    __testResetPresenceState();
    configurePresenceFederation(null);
  });

  it('rejects PATCH with customStatusExpiresAt in the past — 400 custom_status_expires_in_past, no DB write', async () => {
    const { userId, token } = await makeUserWithToken('alice');

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const past = new Date(Date.now() - 60 * 1000).toISOString(); // 1min ago
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/presence',
        headers: { authorization: `Bearer ${token}` },
        payload: { customStatus: 'oops', customStatusExpiresAt: past },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error.message).toBe('custom_status_expires_in_past');

      // No persist: customStatus stays null.
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { customStatus: true, customStatusExpiresAt: true },
      });
      expect(row?.customStatus).toBeNull();
      expect(row?.customStatusExpiresAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/presence returns customStatus + customStatusExpiresAt', async () => {
    const { userId, token } = await makeUserWithToken('bob');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: userId },
      data: { customStatus: 'In a session', customStatusExpiresAt: expiresAt },
    });

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/presence',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        customStatus: 'In a session',
        customStatusExpiresAt: expiresAt.toISOString(),
      });
      // presence + manualDnd still present.
      expect(typeof body.data.presence).toBe('string');
      expect(typeof body.data.manualDnd).toBe('boolean');
    } finally {
      await app.close();
    }
  });

  it('PATCH with customStatus="text" sets the status and returns updated state', async () => {
    const { userId, token } = await makeUserWithToken('carol');

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/presence',
        headers: { authorization: `Bearer ${token}` },
        payload: { customStatus: 'At the pub', customStatusExpiresAt: future },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.customStatus).toBe('At the pub');
      expect(body.data.customStatusExpiresAt).toBe(future);

      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { customStatus: true, customStatusExpiresAt: true },
      });
      expect(row?.customStatus).toBe('At the pub');
      expect(row?.customStatusExpiresAt?.toISOString()).toBe(future);
    } finally {
      await app.close();
    }
  });

  it('PATCH with customStatus=null clears the status', async () => {
    const { userId, token } = await makeUserWithToken('dave');
    await prisma.user.update({
      where: { id: userId },
      data: {
        customStatus: 'pre-existing',
        customStatusExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/presence',
        headers: { authorization: `Bearer ${token}` },
        payload: { customStatus: null },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.customStatus).toBeNull();
      expect(body.data.customStatusExpiresAt).toBeNull();

      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { customStatus: true, customStatusExpiresAt: true },
      });
      expect(row?.customStatus).toBeNull();
      expect(row?.customStatusExpiresAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
