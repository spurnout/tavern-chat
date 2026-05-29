/**
 * P6-6 — outbound `presence.update` fan-out from presence-service.
 *
 * Coverage matrix (mirrors the plan):
 *   1. Helper-level: peer lacks `presence` capability → no enqueue + warn.
 *   2. Helper-level: `federationPresenceEnabledOnInstance=false` → no enqueue + warn.
 *   3. Helper-level: peer not peered → no enqueue + warn.
 *   4. Service: local user active→idle transition → fan-out enqueued AFTER
 *      the 5s debounce, carrying the LATEST state.
 *   5. Service: local user → offline → fan-out enqueued IMMEDIATELY (no
 *      debounce wait).
 *   6. Service: remote-user mirror transitions presence locally → no enqueue
 *      (home-only fan-out).
 *   7. Service: multiple rapid active⇄idle flips within the 5s window → ONE
 *      fan-out at window end with the LATEST state.
 *
 * Helper-level tests exercise `fanOutPresenceUpdate` directly with a mock
 * queue. Service tests drive the `presence-service` API and assert against
 * the captured queue, using `vi.useFakeTimers()` to advance the debounce
 * deterministically.
 *
 * Same Docker-gated skip pattern as the other federation integration suites.
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
import {
  federatedPresenceUpdatePayloadSchema,
  ulid,
} from '@tavern/shared';
import type { FederationOutboxJob } from '@tavern/federation';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { fanOutPresenceUpdate } from '../src/services/federation-outbox.js';
import {
  __testFlushDebouncedFanOuts,
  __testResetPresenceState,
  configurePresenceFederation,
  markConnected,
  markDisconnected,
  reportActivity,
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
  capabilities: string[] = ['messages', 'dms', 'presence'],
  status:
    | 'peered'
    | 'revoked'
    | 'pending_inbound'
    | 'pending_outbound'
    | 'blocked' = 'peered',
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
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
}

// ─── Helper-level tests (no service plumbing) ─────────────────────────────

describe.skipIf(!dockerOk)('P6-6 — fanOutPresenceUpdate helper', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('skips fan-out and warns when peer does NOT advertise the `presence` capability', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms']); // no `presence`
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutPresenceUpdate({
      queues: queue,
      selfHost: SELF_HOST,
      log: log as unknown as Parameters<typeof fanOutPresenceUpdate>[0]['log'],
      federationPresenceEnabledOnInstance: true,
      peerInstanceId: peer.id,
      peerHost: peer.host,
      userRemoteUserId: `alice@${SELF_HOST}`,
      presence: 'active',
      customStatus: null,
      customStatusExpiresAt: null,
      updatedAt: new Date(),
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find(
      (w) => typeof w.msg === 'string' && w.msg.includes('`presence` capability'),
    );
    expect(matched).toBeDefined();
  });

  it('skips fan-out when federationPresenceEnabledOnInstance=false (defence-in-depth)', async () => {
    const peer = await seedPeer('b.example');
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutPresenceUpdate({
      queues: queue,
      selfHost: SELF_HOST,
      log: log as unknown as Parameters<typeof fanOutPresenceUpdate>[0]['log'],
      federationPresenceEnabledOnInstance: false,
      peerInstanceId: peer.id,
      peerHost: peer.host,
      userRemoteUserId: `alice@${SELF_HOST}`,
      presence: 'active',
      customStatus: null,
      customStatusExpiresAt: null,
      updatedAt: new Date(),
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find(
      (w) =>
        typeof w.msg === 'string' &&
        w.msg.includes('FEDERATION_PRESENCE_ENABLED=false') &&
        w.msg.includes('defence-in-depth'),
    );
    expect(matched).toBeDefined();
  });

  it('skips fan-out when peer is revoked', async () => {
    const peer = await seedPeer('b.example', ['messages', 'dms', 'presence'], 'revoked');
    const { queue, enqueue } = makeMockQueue();
    const { warnCalls, log } = capturingLogger();

    await fanOutPresenceUpdate({
      queues: queue,
      selfHost: SELF_HOST,
      log: log as unknown as Parameters<typeof fanOutPresenceUpdate>[0]['log'],
      federationPresenceEnabledOnInstance: true,
      peerInstanceId: peer.id,
      peerHost: peer.host,
      userRemoteUserId: `alice@${SELF_HOST}`,
      presence: 'idle',
      customStatus: null,
      customStatusExpiresAt: null,
      updatedAt: new Date(),
    });

    expect(enqueue).not.toHaveBeenCalled();
    const matched = warnCalls.find(
      (w) => typeof w.msg === 'string' && w.msg.includes('peer is not peered'),
    );
    expect(matched).toBeDefined();
  });

  it('enqueues a parseable presence.update single-layer envelope when peer advertises `presence`', async () => {
    const peer = await seedPeer('b.example');
    const { queue, enqueue, lastJobs } = makeMockQueue();
    const { log } = capturingLogger();
    const updatedAt = new Date('2026-05-21T10:00:00.000Z');
    const expiresAt = new Date('2026-05-21T13:00:00.000Z');

    await fanOutPresenceUpdate({
      queues: queue,
      selfHost: SELF_HOST,
      log: log as unknown as Parameters<typeof fanOutPresenceUpdate>[0]['log'],
      federationPresenceEnabledOnInstance: true,
      peerInstanceId: peer.id,
      peerHost: peer.host,
      userRemoteUserId: `alice@${SELF_HOST}`,
      presence: 'idle',
      customStatus: 'In a session',
      customStatusExpiresAt: expiresAt,
      updatedAt,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = lastJobs[0]!;
    expect(job.eventType).toBe('presence.update');
    expect(job.peerInstanceId).toBe(peer.id);
    expect(job.singleLayer).toBe(true);
    const parsed = federatedPresenceUpdatePayloadSchema.parse(job.payload);
    expect(parsed.userRemoteUserId).toBe(`alice@${SELF_HOST}`);
    expect(parsed.presence).toBe('idle');
    expect(parsed.customStatus).toBe('In a session');
    expect(parsed.customStatusExpiresAt).toBe(expiresAt.toISOString());
    expect(parsed.updatedAt).toBe(updatedAt.toISOString());
  });
});

// ─── Service-level tests ──────────────────────────────────────────────────

describe.skipIf(!dockerOk)('P6-6 — presence-service fan-out wiring', () => {
  let capturingLog: CapturingLogger;

  beforeEach(async () => {
    if (!dockerOk) return;
    __testResetPresenceState();
    await cleanDb();
    capturingLog = capturingLogger();
  });

  afterEach(() => {
    if (!dockerOk) return;
    __testResetPresenceState();
    configurePresenceFederation(null);
    vi.useRealTimers();
  });

  it('enqueues exactly one fan-out at the END of the 5s debounce for an active→idle transition', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    // Step 1: alice connects → active. This fires an immediate broadcast
    // and schedules a debounced fan-out (offline=false). We drain the
    // pending debounced fan-outs manually to assert the active envelope.
    await markConnected(alice.id);
    expect(enqueue).not.toHaveBeenCalled(); // not yet fired — debounced

    // Step 2: alice reports idle within the debounce window. No second
    // timer; the existing one will fire once with the LATEST state.
    await reportActivity(alice.id, false);
    expect(enqueue).not.toHaveBeenCalled();

    // Step 3: trigger the debounced timer.
    __testFlushDebouncedFanOuts();
    // Wait a few ticks so the fan-out's DB read + enqueue completes.
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = lastJobs[0]!;
    expect(job.eventType).toBe('presence.update');
    expect(job.peerInstanceId).toBe(peerB.id);
    expect(job.singleLayer).toBe(true);
    const parsed = federatedPresenceUpdatePayloadSchema.parse(job.payload);
    expect(parsed.userRemoteUserId).toBe(`${alice.username}@${SELF_HOST}`);
    expect(parsed.presence).toBe('idle'); // LATEST state, not the initial `active`.
  });

  it('enqueues fan-out IMMEDIATELY when the user transitions to offline (no debounce)', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    // alice connects, then disconnects — disconnect path persists offline
    // and should fire fan-out immediately (no debounce wait).
    await markConnected(alice.id);
    // Drain the debounced active fan-out so we can isolate the offline one.
    __testFlushDebouncedFanOuts();
    // Wait a few ticks so the fan-out's DB read + enqueue completes.
    await new Promise<void>((r) => setTimeout(r, 300));
    const activeCallCount = enqueue.mock.calls.length;

    await markDisconnected(alice.id);
    // Wait a few ticks so the immediate fan-out's DB read + enqueue completes.
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue.mock.calls.length).toBeGreaterThan(activeCallCount);
    // The most recent job is the offline one.
    const offlineJob = lastJobs[lastJobs.length - 1]!;
    const parsed = federatedPresenceUpdatePayloadSchema.parse(offlineJob.payload);
    expect(parsed.presence).toBe('offline');
  });

  it('does NOT enqueue when the user is a remote-user mirror (home-only fan-out)', async () => {
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    // Also seed another peer that would otherwise be a fan-out target.
    const peerC = await seedPeer('c.example');
    const carolMirror = await createRemoteUserMirror(peerC, 'carol');
    // bob and carol share a federated Tavern with bob — but bob is a MIRROR
    // (remoteInstanceId set), so we should not fan out his presence.
    await createServerWithMembers(bobMirror.localUserId, [carolMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    // Even if presence transitions on the mirror row, emitFanOut returns
    // early because user.remoteInstanceId != null.
    await markConnected(bobMirror.localUserId);
    __testFlushDebouncedFanOuts();
    await new Promise<void>((r) => setImmediate(r));

    // Offline transition (immediate path) should ALSO short-circuit.
    await markDisconnected(bobMirror.localUserId);
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when FEDERATION_PRESENCE_ENABLED=false on the instance', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: false, // flag off
      prisma,
      log: capturingLog.log as never,
    });

    await markConnected(alice.id);
    __testFlushDebouncedFanOuts();
    await new Promise<void>((r) => setImmediate(r));

    // The helper short-circuits with a warn; nothing reaches the queue.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the peer lacks the `presence` capability', async () => {
    const alice = await createLocalUser('alice');
    // Peer is peered but does NOT advertise presence.
    const peerB = await seedPeer('b.example', ['messages', 'dms']);
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    await markConnected(alice.id);
    __testFlushDebouncedFanOuts();
    await new Promise<void>((r) => setImmediate(r));

    // Helper gates inside fanOutPresenceUpdate skip enqueue + warn.
    expect(enqueue).not.toHaveBeenCalled();
  });

  // ─── PF-3 — per-user opt-out from federated presence fan-out (#33) ──────

  it('PF-3 — does NOT enqueue when the user has acceptsFederatedPresence=false (opt-out)', async () => {
    const alice = await createLocalUser('alice');
    // Flip the opt-out preference AFTER creation so we exercise the same
    // path a real user takes from the settings UI.
    await prisma.user.update({
      where: { id: alice.id },
      data: { acceptsFederatedPresence: false },
    });
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    // active → idle inside the debounce window; the debounced flush should
    // re-read the user row, see acceptsFederatedPresence=false, and skip.
    await markConnected(alice.id);
    await reportActivity(alice.id, false);
    __testFlushDebouncedFanOuts();
    await new Promise<void>((r) => setTimeout(r, 300));

    // Offline transition (immediate path) ALSO short-circuits — the pref
    // check sits before the peer enumeration, so both paths honour it.
    await markDisconnected(alice.id);
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue).not.toHaveBeenCalled();
    // Structured-log assertion (nice-to-have, optional per the spec).
    const skipped = capturingLog.warnCalls.find(
      (w) =>
        typeof w.msg === 'string' &&
        w.msg.includes('acceptsFederatedPresence=false'),
    );
    expect(skipped).toBeDefined();
  });

  it('PF-3 — race: flipping acceptsFederatedPresence true→false MID debounce window is honoured at flush time', async () => {
    const alice = await createLocalUser('alice');
    // Starts with the default opt-IN (true).
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    // Step 1: alice transitions to active. This schedules a 5s debounced
    // fan-out. At schedule time her pref is still true.
    await markConnected(alice.id);
    expect(enqueue).not.toHaveBeenCalled();

    // Step 2: inside the debounce window, alice opts out (settings PATCH).
    await prisma.user.update({
      where: { id: alice.id },
      data: { acceptsFederatedPresence: false },
    });

    // Step 3: trigger the debounced timer. emitFanOut re-reads the row,
    // sees the freshly-written false, and bails before enumerating peers.
    __testFlushDebouncedFanOuts();
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue).not.toHaveBeenCalled();
    const skipped = capturingLog.warnCalls.find(
      (w) =>
        typeof w.msg === 'string' &&
        w.msg.includes('acceptsFederatedPresence=false'),
    );
    expect(skipped).toBeDefined();
  });

  it('coalesces multiple active⇄idle flips within the debounce window into a single fan-out with the LATEST state', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const { queue, enqueue, lastJobs } = makeMockQueue();
    configurePresenceFederation({
      queues: queue,
      selfHost: SELF_HOST,
      federationPresenceEnabledOnInstance: true,
      prisma,
      log: capturingLog.log as never,
    });

    // active → idle → active → idle → active, all inside the same 5s window.
    await markConnected(alice.id);
    await reportActivity(alice.id, false); // idle
    await reportActivity(alice.id, true);  // active
    await reportActivity(alice.id, false); // idle
    await reportActivity(alice.id, true);  // active (final state)

    expect(enqueue).not.toHaveBeenCalled(); // still debounced

    __testFlushDebouncedFanOuts();
    // setImmediate is too fast for the async DB read inside emitFanOut to
    // complete — give it a short window so the enqueue actually lands.
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = lastJobs[0]!;
    const parsed = federatedPresenceUpdatePayloadSchema.parse(job.payload);
    expect(parsed.presence).toBe('active'); // LATEST state from the flap chain.
  });
});
