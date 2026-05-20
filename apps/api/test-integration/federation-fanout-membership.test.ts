/**
 * P4-10 — outbound fan-out for `member.add` / `member.remove`.
 *
 * Coverage matrix:
 *   1. Local user joins via local invite → `member.add` enqueued for each
 *      peer with a member in T (excluding the joiner's home — joiner is
 *      local in this scenario so no home to exclude).
 *   2. Multiple peers → one enqueue per peer (deduped at the helper layer
 *      via `findPeersWithRemoteMembers`).
 *   3. Mirror server (originInstanceId != null) → no enqueue.
 *   4. P4-7 federated-invite-accept inbound flow → A receives the
 *      `member.join_request`, accepts it, AND fans out `member.add` to
 *      peers OTHER than the joiner's home (B is excluded; C still
 *      receives).
 *   5. Kick → `member.remove` envelope with reason='kicked' to peers.
 *   6. Ban a remote user → `member.remove` envelope with reason='banned'
 *      to all remaining peers AND to the removed user's home, even when
 *      that home had no other members in T.
 *   7. Non-federated server → no enqueue on join or kick.
 *
 * The queue is a vi.fn() throughout — dispatch is covered by the
 * federation-outbox.test.ts suite from P3-5.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
// IMPORTANT: ./setup.js must import BEFORE any module that transitively pulls
// in @tavern/db (the Prisma singleton is created when @tavern/db loads, and
// it reads DATABASE_URL eagerly). @tavern/federation imports @tavern/db, so
// it MUST come after the setup import.
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import {
  PERMISSION_DEFAULT_EVERYONE,
  memberAddPayloadSchema,
  memberRemovePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  exportPublicKeyRaw,
  generateKeyPair,
  sign as edSign,
  type FederationOutboxJob,
} from '@tavern/federation';

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

interface PeerSeed {
  peerId: string;
  peerHost: string;
  peerKp: ReturnType<typeof generateKeyPair>;
  /** Local synthetic user that represents a peer member in T. */
  remoteMemberLocalUserId: string;
  remoteMemberRemoteUserId: string;
}

interface Fixture {
  ownerId: string;
  ownerUsername: string;
  serverId: string;
  channelId: string;
  peers: PeerSeed[];
}

async function createLocalUser(username?: string): Promise<{ id: string; username: string }> {
  const id = ulid();
  const u = username ?? `u-${id.slice(-8).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username: u,
      usernameLower: u.toLowerCase(),
      displayName: u,
      email: `${id.toLowerCase()}@example.com`,
      emailLower: `${id.toLowerCase()}@example.com`,
      passwordHash: 'x',
    },
  });
  return { id, username: u };
}

async function createRemoteUserOnServer(
  serverId: string,
  peer: { id: string; host: string },
  opts?: { localpart?: string },
): Promise<{ localUserId: string; remoteUserId: string }> {
  const localpart =
    opts?.localpart ?? `rem-${ulid().slice(-6).toLowerCase()}`;
  const qualified = `${localpart}@${peer.host}`;
  const remoteUserRowId = ulid();
  const localUserId = ulid();

  await prisma.remoteUser.create({
    data: {
      id: remoteUserRowId,
      remoteInstanceId: peer.id,
      remoteUserId: qualified,
      displayNameCache: localpart,
      avatarUrlCache: null,
      // 32-byte placeholder ed25519 key — these tests don't exercise the
      // verifier, only the fan-out gates.
      publicKey: randomBytes(32),
    },
  });
  await prisma.user.create({
    data: {
      id: localUserId,
      username: localpart,
      usernameLower: localpart.toLowerCase(),
      displayName: localpart,
      email: `${localUserId.toLowerCase()}@${peer.host}`,
      emailLower: `${localUserId.toLowerCase()}@${peer.host}`,
      passwordHash: null,
      remoteUserId: qualified,
      remoteInstanceId: peer.id,
    },
  });
  await prisma.serverMember.create({
    data: { serverId, userId: localUserId },
  });
  return { localUserId, remoteUserId: qualified };
}

async function seedPeer(opts?: { status?: 'peered' | 'revoked' }): Promise<{
  id: string;
  host: string;
  kp: ReturnType<typeof generateKeyPair>;
}> {
  const id = ulid();
  const host = `peer-${id.slice(-8).toLowerCase()}.example`;
  const kp = generateKeyPair();
  await prisma.remoteInstance.create({
    data: {
      id,
      host,
      instanceKey: exportPublicKeyRaw(kp.publicKey),
      status: opts?.status ?? 'peered',
      capabilities: ['messages'],
      peeredAt: new Date(),
    },
  });
  return { id, host, kp };
}

interface MakeFixtureOpts {
  federationEnabled?: boolean;
  isMirror?: boolean;
  peerCount?: number;
}

async function makeFixture(opts?: MakeFixtureOpts): Promise<Fixture> {
  const peerCount = opts?.peerCount ?? 1;
  const owner = await createLocalUser(`owner-${ulid().slice(-6).toLowerCase()}`);
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();

  // Seed N peers + one remote member each so `findPeersWithRemoteMembers`
  // returns each of them. The `isMirror` test variant still seeds a peer
  // for assertion-by-omission ("would have fanned out if the gate had
  // let it through").
  const peers: PeerSeed[] = [];
  for (let i = 0; i < peerCount; i++) {
    const peer = await seedPeer();
    peers.push({
      peerId: peer.id,
      peerHost: peer.host,
      peerKp: peer.kp,
      remoteMemberLocalUserId: '',
      remoteMemberRemoteUserId: '',
    });
  }

  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: owner.id,
      name: 'Fed Tavern',
      federationEnabled: opts?.federationEnabled ?? true,
      // Mirror fixture: pretend the first peer originated T. Real mirrors
      // are owned by a synthetic remote user; we leave the local owner so
      // the route layer can still resolve permissions for the test token.
      originInstanceId: opts?.isMirror ? peers[0]?.peerId ?? null : null,
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

  // Attach one remote member per peer so the peer set is non-empty even
  // after the joiner under test arrives.
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i]!;
    const remote = await createRemoteUserOnServer(
      serverId,
      { id: peer.peerId, host: peer.peerHost },
    );
    peer.remoteMemberLocalUserId = remote.localUserId;
    peer.remoteMemberRemoteUserId = remote.remoteUserId;
  }

  return {
    ownerId: owner.id,
    ownerUsername: owner.username,
    serverId,
    channelId,
    peers,
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
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
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
  await prisma.invite.deleteMany({});
  await prisma.serverBan.deleteMany({});
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

describe.skipIf(!dockerOk)('P4-10 — outbound fan-out (membership add/remove)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  // ─── 1. Local user joins via local invite ──────────────────────────────────

  it('local user joins via local invite → member.add enqueued for each peer', async () => {
    const fx = await makeFixture();

    // Mint a local invite owned by the server owner.
    const inviteId = ulid();
    const inviteCode = `INV-${ulid().slice(-8).toLowerCase()}`;
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        createdById: fx.ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    // A brand-new local user who isn't in T yet.
    const joiner = await createLocalUser();

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
      const token = await mintTokenFor(joiner.id);
      const res = await app.inject({
        method: 'POST',
        url: `/api/invites/${inviteCode}/join`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peers[0]!.peerId);
      expect(job.eventType).toBe('member.add');
      expect(job.authorUserId).toBe(joiner.id);

      const payload = memberAddPayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.memberRemoteUserId).toBe(`${joiner.username}@${SELF_HOST}`);
      expect(payload.memberDisplayName).toBe(joiner.username);
    } finally {
      await app.close();
    }
  });

  // ─── 2. Multiple peers ────────────────────────────────────────────────────

  it('two peers with members → join fires one member.add per peer', async () => {
    const fx = await makeFixture({ peerCount: 2 });

    const inviteId = ulid();
    const inviteCode = `INV-${ulid().slice(-8).toLowerCase()}`;
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        createdById: fx.ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    const joiner = await createLocalUser();

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
      const token = await mintTokenFor(joiner.id);
      const res = await app.inject({
        method: 'POST',
        url: `/api/invites/${inviteCode}/join`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(2);
      const peerIdsHit = new Set(captured.map((j) => j.peerInstanceId));
      expect(peerIdsHit).toEqual(
        new Set(fx.peers.map((p) => p.peerId)),
      );
      for (const job of captured) {
        expect(job.eventType).toBe('member.add');
      }
    } finally {
      await app.close();
    }
  });

  // ─── 3. Mirror server → no fan-out ────────────────────────────────────────

  it('mirror server → join does NOT enqueue', async () => {
    const fx = await makeFixture({ isMirror: true });

    const inviteId = ulid();
    const inviteCode = `INV-${ulid().slice(-8).toLowerCase()}`;
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        createdById: fx.ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    const joiner = await createLocalUser();

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
      const token = await mintTokenFor(joiner.id);
      const res = await app.inject({
        method: 'POST',
        url: `/api/invites/${inviteCode}/join`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ─── 4. P4-7 inbound flow: exclude joiner's home, hit other peers ─────────

  it('inbound member.join_request: fans out member.add to OTHER peers, not the joiner home', async () => {
    // Two peers — B (the joiner's home) and C (charlie's home, charlie is
    // an existing member). When B's `member.join_request` lands, the
    // post-commit fan-out should hit C and NOT B.
    const fx = await makeFixture({ peerCount: 2 });
    const homePeer = fx.peers[0]!;   // B — will be the joiner's home
    const otherPeer = fx.peers[1]!;  // C — already has a member

    // Mint a federated invite (`any_peer` scope) so B's join_request is
    // accepted by A.
    const inviteId = ulid();
    const inviteCode = `INV-${ulid().slice(-8).toLowerCase()}`;
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        createdById: fx.ownerId,
        maxUses: null,
        uses: 0,
        remoteScope: 'any_peer',
        remoteInstanceHost: null,
        remoteUserId: null,
      },
    });

    // Pre-seed the joiner as a RemoteUser on B (the handler validates the
    // user-layer signature against `RemoteUser.publicKey`, so we need a
    // real keypair here).
    const joinerKp = generateKeyPair();
    const joinerLocalpart = `bob-${ulid().slice(-6).toLowerCase()}`;
    const joinerRemoteUserId = `${joinerLocalpart}@${homePeer.peerHost}`;
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: homePeer.peerId,
        remoteUserId: joinerRemoteUserId,
        displayNameCache: 'Bob',
        avatarUrlCache: null,
        publicKey: exportPublicKeyRaw(joinerKp.publicKey),
      },
    });

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
      const envelope = buildTwoLayerMessageEnvelope({
        eventType: 'member.join_request',
        fromInstance: homePeer.peerHost,
        toInstance: SELF_HOST,
        payload: {
          inviteCode,
          joinerRemoteUserId,
        },
        signUser: (b: Buffer) => edSign(b, joinerKp.privateKey),
        signInstance: (b: Buffer) => edSign(b, homePeer.peerKp.privateKey),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      // Wait one tick for the async postCommit hook to run (the dispatch
      // route awaits postCommit before returning, so the queue call is
      // already on the stack by here — no explicit sleep needed).
      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('member.add');
      // CRITICAL: NOT the joiner's home (homePeer). Only the other peer.
      expect(job.peerInstanceId).toBe(otherPeer.peerId);
      expect(job.peerInstanceId).not.toBe(homePeer.peerId);

      const payload = memberAddPayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.memberRemoteUserId).toBe(joinerRemoteUserId);
      expect(payload.memberDisplayName).toBe('Bob');
    } finally {
      await app.close();
    }
  });

  // ─── 5. Kick a local member → member.remove with reason='kicked' ──────────

  it('kick local member → member.remove enqueued with reason=kicked', async () => {
    const fx = await makeFixture();

    // Add a second local user (not the owner — owners can't be kicked).
    const target = await createLocalUser();
    await prisma.serverMember.create({
      data: { serverId: fx.serverId, userId: target.id },
    });

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
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${fx.serverId}/members/${target.id}/kick`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'noisy' },
      });
      expect(res.statusCode).toBe(200);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peers[0]!.peerId);
      expect(job.eventType).toBe('member.remove');
      expect(job.authorUserId).toBe(fx.ownerId);

      const payload = memberRemovePayloadSchema.parse(job.payload);
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.memberRemoteUserId).toBe(`${target.username}@${SELF_HOST}`);
      expect(payload.reason).toBe('kicked');
    } finally {
      await app.close();
    }
  });

  // ─── 6. Ban a remote user → member.remove with reason='banned' ────────────

  it('ban remote member → member.remove enqueued for all peers including the banned home', async () => {
    // Two peers — B (where the banned user lives) and C (another peer
    // with a member in T). The ban removes B's only member, so without
    // `additionalPeerInstanceIds`, the post-delete `findPeersWithRemoteMembers`
    // would NOT return B. The helper unions B back in so it learns of
    // the removal.
    const fx = await makeFixture({ peerCount: 2 });
    const bannedHome = fx.peers[0]!;
    const otherPeer = fx.peers[1]!;
    const bannedLocalUserId = bannedHome.remoteMemberLocalUserId;
    const bannedRemoteUserId = bannedHome.remoteMemberRemoteUserId;

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
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${fx.serverId}/bans`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          userId: bannedLocalUserId,
          reason: 'abusive',
        },
      });
      expect(res.statusCode).toBe(201);

      // Two enqueues — one for each peer. Order is not stable (helper
      // iterates a Set) so check by set membership.
      expect(enqueue).toHaveBeenCalledTimes(2);
      const peerIdsHit = new Set(captured.map((j) => j.peerInstanceId));
      expect(peerIdsHit).toEqual(
        new Set([bannedHome.peerId, otherPeer.peerId]),
      );
      for (const job of captured) {
        expect(job.eventType).toBe('member.remove');
        const payload = memberRemovePayloadSchema.parse(job.payload);
        expect(payload.serverId).toBe(fx.serverId);
        expect(payload.memberRemoteUserId).toBe(bannedRemoteUserId);
        expect(payload.reason).toBe('banned');
      }
    } finally {
      await app.close();
    }
  });

  // ─── 7. Non-federated server → no fan-out on join or kick ─────────────────

  it('non-federated server → join + kick produce no fan-out', async () => {
    const fx = await makeFixture({ federationEnabled: false });

    const inviteId = ulid();
    const inviteCode = `INV-${ulid().slice(-8).toLowerCase()}`;
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        createdById: fx.ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    const joiner = await createLocalUser();

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
      const tokenJoiner = await mintTokenFor(joiner.id);
      const join = await app.inject({
        method: 'POST',
        url: `/api/invites/${inviteCode}/join`,
        headers: { authorization: `Bearer ${tokenJoiner}` },
      });
      expect(join.statusCode).toBe(200);

      const tokenOwner = await mintTokenFor(fx.ownerId);
      const kick = await app.inject({
        method: 'POST',
        url: `/api/servers/${fx.serverId}/members/${joiner.id}/kick`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { reason: null },
      });
      expect(kick.statusCode).toBe(200);

      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
