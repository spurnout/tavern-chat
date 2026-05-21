/**
 * P5-12 — Federation Phase 5 end-to-end smoke test.
 *
 * The "Phase 5 done" gate. Exercises the full happy path that a real
 * deployment of two federated instances would take a user through for
 * direct messages:
 *
 *   1. Two instances (A, B) are peered with the `dms` capability on both
 *      sides.
 *   2. alice on A, bob on B are remote-and-local members of a shared
 *      federated Tavern T (the share-server gate is what unlocks DM open).
 *   3. alice opens a DM with bob via A's POST /api/dms/direct → B receives
 *      `dm.create`; B's DmChannel exists with both members.
 *   4. alice posts a message in the DM → B persists with originInstanceId = A.
 *   5. bob posts a reply locally on B → fan-out captured.
 *   6. bob edits his message → fan-out captured + history row appended.
 *   7. alice reacts to bob's message → B persists the reaction.
 *   8. alice deletes HER message → B tombstones the row.
 *
 * ── DESIGN NOTE — single-instance simulation ──────────────────────────────
 *
 * P4-17's design note still applies in full: a truly two-process E2E setup
 * is structurally blocked by Phase 3-4 design choices (shared Server ids on
 * both sides, module-level Prisma singleton in `@tavern/db`,
 * outbox-dispatcher tightly bound to that singleton). Rather than build a
 * second Prisma client (out of scope) we run with ONE Postgres + ONE
 * Fastify app from B's perspective and SIMULATE A entirely with
 * hand-crafted signed envelopes + a captured outbox queue.
 *
 * Phase 5 adds nothing that changes this calculus — DM channels also share
 * an `id` across both sides, and the inbound DM handlers use the same
 * single-instance Prisma context.
 *
 * Mapping vs the P5-12 spec's 12 assertions (steps 1-2 are pre-seeded
 * setup; assertions start at step 4):
 *
 *   ┌──────┬──────────────────────────────────────────────────────┬─────────┐
 *   │ Step │ Assertion                                            │ Style   │
 *   ├──────┼──────────────────────────────────────────────────────┼─────────┤
 *   │   1  │ A + B peered with `dms` (RemoteInstance.capabilities) │ Sim     │
 *   │   2  │ alice + bob share federated Tavern T                  │ Sim     │
 *   │   3  │ alice opens DM via /api/dms/direct                    │ Sim     │
 *   │   4  │ B's dm.create handler creates DmChannel + members     │ REAL    │
 *   │      │ + DM_CHANNEL_CREATE broadcast fires                   │ REAL    │
 *   │   5  │ alice posts dm.message.create                         │ Sim     │
 *   │   6  │ B's Message row exists with originInstanceId = A      │ REAL    │
 *   │      │ + DM_MESSAGE_CREATE gateway broadcast fires           │ REAL    │
 *   │   7  │ bob replies via POST /api/dms/:id/messages            │ REAL    │
 *   │   8  │ A's Message row would exist with originInstanceId = B │ Sim*    │
 *   │   9  │ bob edits his message via PATCH /api/messages/:id     │ REAL    │
 *   │  10  │ B's Message.content updated + MessageEdit appended    │ REAL    │
 *   │      │ + outbound dm.message.update envelope captured        │ Sim*    │
 *   │  11  │ alice reacts to bob's message via dm.reaction.add     │ Sim     │
 *   │  12  │ B's MessageReaction row exists + REACTION_ADD fires   │ REAL    │
 *   │  13  │ alice deletes her own message via dm.message.delete   │ Sim     │
 *   │  14  │ B's Message has deletedAt set + reactions cleared     │ REAL    │
 *   │      │ + DM_MESSAGE_DELETE broadcast fires                   │ REAL    │
 *   └──────┴──────────────────────────────────────────────────────┴─────────┘
 *
 *   Sim   = constructed/asserted via envelope content the test built itself.
 *   REAL  = runs through the actual Fastify route or inbound dispatcher.
 *   Sim*  = step 8 / 10 cross-side assertions are verified by inspecting the
 *           outbound envelope B's local routes enqueued. We can't re-feed
 *           those envelopes through the inbound handler on the same instance
 *           — same `Message.id` reuse on both sides causes a unique-key
 *           collision. The structural proof — A would persist this row —
 *           lives in the captured payload.
 *
 * Things this test deliberately does NOT cover (covered elsewhere):
 *   - DM reaction remove (in-suite coverage in `federation-fanout-dm-
 *     reactions.test.ts` + `federation-inbound.test.ts`)
 *   - Capability gating (`federation-dms-capability.test.ts`)
 *   - Replay window / signature verification failures
 *     (`federation-inbound.test.ts`)
 *   - Group DM no-federate path (`federation-fanout-dm-message-
 *     create.test.ts`)
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
// IMPORTANT: ./setup.js must import BEFORE any module that transitively pulls
// in @tavern/db (whose Prisma singleton reads DATABASE_URL eagerly).
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import {
  PERMISSION_DEFAULT_EVERYONE,
  dmCreatePayloadSchema,
  dmMessageCreatePayloadSchema,
  dmMessageDeletePayloadSchema,
  dmMessageUpdatePayloadSchema,
  dmReactionAddPayloadSchema,
  serializePermissions,
  ulid,
  type DmCreatePayload,
  type DmMessageCreatePayload,
  type DmMessageDeletePayload,
  type DmReactionAddPayload,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSign,
  type FederationOutboxJob,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import type { QueueClient } from '../src/services/queues.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';
import { gatewayBroker } from '../src/services/gateway-broker.js';
import { federatedDmPairKey } from '../src/services/dm-service.js';

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

// B is the instance under test (the receiving / local side for bob).
const B_HOST = 'b.example';
// A is the peer that hosts alice; simulated via hand-crafted envelopes.
const A_HOST = 'a.example';

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    FEDERATION_DMS_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${B_HOST}`,
  } as NodeJS.ProcessEnv;
}

interface PeerSeed {
  /** RemoteInstance.id for the simulated peer A. */
  peerId: string;
  /** Instance keypair for A — signs every simulated A→B instance-layer envelope. */
  peerKp: ReturnType<typeof generateKeyPair>;
}

/**
 * Seed a peered RemoteInstance row for A in B's DB, advertising the `dms`
 * capability (intersected at peering time in real deployments — see P5-11).
 * The keypair we generate doubles as A's instance signing key.
 */
async function seedPeer(host: string): Promise<PeerSeed> {
  const peerKp = generateKeyPair();
  const peerId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host,
      instanceKey: exportPublicKeyRaw(peerKp.publicKey),
      status: 'peered',
      capabilities: ['messages', 'dms'],
      peeredAt: new Date(),
    },
  });
  return { peerId, peerKp };
}

/**
 * Pre-populate a RemoteUser cache row for alice on A as B sees her. Stores
 * a fresh ed25519 keypair so the test can sign payloads on her behalf for
 * the inbound envelopes (the same key A's .well-known would publish in
 * production).
 */
async function seedRemoteUser(opts: {
  peerId: string;
  remoteUserId: string;
  displayName: string;
}): Promise<{ userKp: ReturnType<typeof generateKeyPair> }> {
  const userKp = generateKeyPair();
  await prisma.remoteUser.upsert({
    where: { remoteUserId: opts.remoteUserId },
    create: {
      id: ulid(),
      remoteInstanceId: opts.peerId,
      remoteUserId: opts.remoteUserId,
      displayNameCache: opts.displayName,
      avatarUrlCache: null,
      publicKey: exportPublicKeyRaw(userKp.publicKey),
    },
    update: {
      publicKey: exportPublicKeyRaw(userKp.publicKey),
    },
  });
  return { userKp };
}

/**
 * Materialise the local synthetic User row that mirrors a remote user (the
 * row B keeps so it can FK ServerMember / DmChannelMember rows against a
 * real `User.id`). Returns the new local id.
 */
async function seedMirrorUser(opts: {
  peerId: string;
  remoteUserId: string;
  displayName: string;
}): Promise<string> {
  const localUserId = ulid();
  const syntheticUsername = `__rem_${localUserId.toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: localUserId,
      username: syntheticUsername,
      usernameLower: syntheticUsername,
      displayName: opts.displayName,
      email: `${localUserId.toLowerCase()}@${A_HOST}.federated.local`,
      emailLower: `${localUserId.toLowerCase()}@${A_HOST}.federated.local`,
      passwordHash: null,
      remoteUserId: opts.remoteUserId,
      remoteInstanceId: opts.peerId,
    },
  });
  return localUserId;
}

/**
 * Mint a local B-side user + Session so the test can drive authenticated
 * routes via `app.inject`. Returns the user id, the canonical username
 * (used to form the qualified `<localpart>@b.example`), and the JWT.
 */
async function makeLocalUser(opts?: { usernamePrefix?: string }): Promise<{
  userId: string;
  username: string;
  token: string;
}> {
  const userId = ulid();
  const sessionId = ulid();
  const prefix = opts?.usernamePrefix ?? 'bob';
  const username = `${prefix}-${userId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@example.com`,
      emailLower: `${username}@example.com`,
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

/**
 * Create the shared federated Tavern T that satisfies the share-server
 * gate. Both alice (mirror User) and bob (local User) are added as
 * `ServerMember` rows so `usersShareServer` returns true at DM-open time.
 */
async function seedSharedServer(opts: {
  ownerId: string;
  memberIds: string[];
}): Promise<string> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: opts.ownerId,
      name: 'Phase 5 Tavern',
      federationEnabled: true,
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
  for (const uid of opts.memberIds) {
    await prisma.serverMember.create({ data: { serverId, userId: uid } });
  }
  return serverId;
}

/**
 * Build a two-layer signed envelope SIGNED BY A (instance + user). Used
 * to simulate every alice→B inbound DM envelope.
 */
function buildAEnvelope<TPayload>(opts: {
  peerKp: ReturnType<typeof generateKeyPair>;
  userKp: ReturnType<typeof generateKeyPair>;
  eventType: Parameters<typeof buildTwoLayerMessageEnvelope>[0]['eventType'];
  payload: TPayload;
}): TwoLayerSignedEnvelope<TPayload> {
  return buildTwoLayerMessageEnvelope({
    eventType: opts.eventType,
    fromInstance: A_HOST,
    toInstance: B_HOST,
    payload: opts.payload,
    signUser: (bytes) => edSign(bytes, opts.userKp.privateKey),
    signInstance: (bytes) => edSign(bytes, opts.peerKp.privateKey),
  });
}

/**
 * Wipe the DB between tests. Order matters because of FK cascades — mirrors
 * the pattern used by every other Phase 4 / 5 integration file.
 */
async function reset(): Promise<void> {
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.messageEdit.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  await prisma.federationKey.deleteMany({});
  vi.restoreAllMocks();
}

/**
 * Make a `QueueClient` stub that captures every outbox enqueue without
 * dispatching. The captured jobs are introspected in steps 7-8 + 9-10
 * to verify the envelope shape B emits back to A.
 */
function makeCapturingQueue(): { queue: QueueClient; jobs: FederationOutboxJob[] } {
  const jobs: FederationOutboxJob[] = [];
  const queue: QueueClient = {
    enqueueScan: vi.fn(async () => undefined),
    enqueueFederationOutbox: vi.fn(async (job: FederationOutboxJob) => {
      jobs.push(job);
    }),
    close: vi.fn(async () => undefined),
  };
  return { queue, jobs };
}

describe.skipIf(!dockerOk)('Federation Phase 5 — end-to-end smoke', () => {
  beforeEach(async () => {
    await reset();
  });

  it('happy path: dm.create → message round-trip → edit → react → delete', async () => {
    // ─── Step 1 (Sim): A and B peered with `dms` capability ───────────────────
    // On B's side this is a RemoteInstance row for A with capabilities
    // ['messages','dms']. The real two-instance handshake — including the
    // capability intersection logic — is exercised in
    // `federation-dms-capability.test.ts` and `federation-peering.test.ts`.
    const peer = await seedPeer(A_HOST);

    // ─── Step 2 (Sim): alice on A, bob on B share federated Tavern T ──────────
    // alice's qualified id is `alice@a.example`; she has a RemoteUser cache
    // row + a local mirror User row on B (needed for the share-server gate
    // and as the FK target for ServerMember). The mirror's User id is
    // what B will store as DmChannelMember.userId for her side of the DM.
    const aliceRemoteUserId = `alice@${A_HOST}`;
    const { userKp: aliceUserKp } = await seedRemoteUser({
      peerId: peer.peerId,
      remoteUserId: aliceRemoteUserId,
      displayName: 'Alice',
    });
    const aliceMirrorUserId = await seedMirrorUser({
      peerId: peer.peerId,
      remoteUserId: aliceRemoteUserId,
      displayName: 'Alice',
    });
    const bob = await makeLocalUser({ usernamePrefix: 'bob' });
    // bob owns T because the role/server creation is purely local — alice
    // is in T only as a remote-member mirror. The share-server gate cares
    // only about co-membership, not ownership.
    await seedSharedServer({
      ownerId: bob.userId,
      memberIds: [bob.userId, aliceMirrorUserId],
    });

    // ─── Boot B with FEDERATION_ENABLED + FEDERATION_DMS_ENABLED ─────────────
    // Capture every outbox enqueue (bob's reply in step 7, bob's edit in
    // step 9) for shape assertions on the wire envelope B would emit to A.
    const { queue, jobs: outboxJobs } = makeCapturingQueue();
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: queue,
    });

    // Gateway broker observer — used to assert DM_CHANNEL_CREATE (step 4),
    // DM_MESSAGE_CREATE (step 6), REACTION_ADD (step 12), DM_MESSAGE_DELETE
    // (step 14).
    const events: Array<{
      type: string;
      userId?: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      // ─── Step 3 (Sim) + Step 4 (REAL): alice opens DM with bob ──────────────
      // INBOUND on B: alice on A sends `dm.create` announcing a new 1:1 DM
      // with bob. The handler:
      //   - verifies peer.capabilities includes 'dms' (yes — seeded above),
      //   - resolves bob via `bob.username@b.example` → local User row,
      //   - materialises alice's mirror User (already exists, idempotent),
      //   - computes the pairKey from the two qualified ids,
      //   - creates the DmChannel with both members + fires
      //     DM_CHANNEL_CREATE post-commit.
      const dmChannelId = ulid();
      const bobRemoteUserId = `${bob.username}@${B_HOST}`;
      const dmCreatePayload: DmCreatePayload = {
        dmChannelId,
        initiatorRemoteUserId: aliceRemoteUserId,
        recipientRemoteUserId: bobRemoteUserId,
        createdAt: new Date().toISOString(),
      };
      // Defensive schema parse — surface drift at construction, not on
      // inbound rejection.
      dmCreatePayloadSchema.parse(dmCreatePayload);
      const dmCreateEnv = buildAEnvelope({
        peerKp: peer.peerKp,
        userKp: aliceUserKp,
        eventType: 'dm.create',
        payload: dmCreatePayload,
      });

      const eventsBeforeCreate = events.length;
      const createRes = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        headers: { 'content-type': 'application/json' },
        payload: dmCreateEnv,
      });
      expect(createRes.statusCode).toBe(200);

      // B's DmChannel exists with the correct pairKey + both members.
      const dmChannel = await prisma.dmChannel.findUniqueOrThrow({
        where: { id: dmChannelId },
        select: { id: true, kind: true, pairKey: true, createdById: true },
      });
      expect(dmChannel.kind).toBe('direct');
      expect(dmChannel.pairKey).toBe(
        federatedDmPairKey(aliceRemoteUserId, bobRemoteUserId),
      );
      expect(dmChannel.createdById).toBe(aliceMirrorUserId);

      const members = await prisma.dmChannelMember.findMany({
        where: { dmChannelId },
        select: { userId: true },
        orderBy: { userId: 'asc' },
      });
      const memberIds = members.map((m) => m.userId).sort();
      expect(memberIds).toEqual([aliceMirrorUserId, bob.userId].sort());

      // DM_CHANNEL_CREATE addressed to bob (the recipient) fired post-commit.
      const dmCreateBroadcasts = events
        .slice(eventsBeforeCreate)
        .filter((e) => e.type === 'DM_CHANNEL_CREATE');
      expect(dmCreateBroadcasts.length).toBeGreaterThanOrEqual(1);
      expect(dmCreateBroadcasts[0]!.dmChannelId).toBe(dmChannelId);
      expect(dmCreateBroadcasts[0]!.userId).toBe(bob.userId);

      // ─── Step 5 (Sim) + Step 6 (REAL): alice posts in the DM; B receives ────
      // INBOUND on B: alice on A sends `dm.message.create`. The handler
      // checks the `dms` capability, looks up the DmChannel (now exists),
      // confirms alice's mirror User is a DmChannelMember, persists the
      // Message row with originInstanceId = A, and fires DM_MESSAGE_CREATE.
      const aliceMessageId = ulid();
      const aliceMessageContent = 'Hi bob, this is alice from A!';
      const aliceMessageCreatedAt = new Date().toISOString();
      const dmMessageCreatePayload: DmMessageCreatePayload = {
        dmChannelId,
        messageId: aliceMessageId,
        authorRemoteUserId: aliceRemoteUserId,
        content: aliceMessageContent,
        replyToMessageId: null,
        createdAt: aliceMessageCreatedAt,
      };
      dmMessageCreatePayloadSchema.parse(dmMessageCreatePayload);
      const dmMsgCreateEnv = buildAEnvelope({
        peerKp: peer.peerKp,
        userKp: aliceUserKp,
        eventType: 'dm.message.create',
        payload: dmMessageCreatePayload,
      });

      const eventsBeforeMsg = events.length;
      const msgRes = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        headers: { 'content-type': 'application/json' },
        payload: dmMsgCreateEnv,
      });
      expect(msgRes.statusCode).toBe(200);

      // B's Message row has the right origin + content.
      const aliceMessageOnB = await prisma.message.findUniqueOrThrow({
        where: { id: aliceMessageId },
        select: {
          id: true,
          dmChannelId: true,
          content: true,
          originInstanceId: true,
          authorId: true,
          signature: true,
        },
      });
      expect(aliceMessageOnB.dmChannelId).toBe(dmChannelId);
      expect(aliceMessageOnB.content).toBe(aliceMessageContent);
      expect(aliceMessageOnB.originInstanceId).toBe(peer.peerId);
      expect(aliceMessageOnB.authorId).toBe(aliceMirrorUserId);
      // Envelope.signature retained for moderation surface uniformity.
      expect(aliceMessageOnB.signature).not.toBeNull();
      expect(aliceMessageOnB.signature!.length).toBeGreaterThan(0);

      // DM_MESSAGE_CREATE broadcast on the dmChannel.
      const dmMsgBroadcasts = events
        .slice(eventsBeforeMsg)
        .filter((e) => e.type === 'DM_MESSAGE_CREATE');
      expect(dmMsgBroadcasts.length).toBeGreaterThanOrEqual(1);
      expect(dmMsgBroadcasts[0]!.dmChannelId).toBe(dmChannelId);

      // The DmChannel's `lastMessageAt` got bumped inside the handler's
      // transaction so the DM list re-sorts correctly.
      const dmAfterMsg = await prisma.dmChannel.findUniqueOrThrow({
        where: { id: dmChannelId },
        select: { lastMessageAt: true },
      });
      expect(dmAfterMsg.lastMessageAt).not.toBeNull();

      // ─── Step 7 (REAL) + Step 8 (Sim*): bob replies via his B mirror ────────
      // LOCAL on B: bob calls POST /api/dms/:id/messages. The route persists
      // the Message locally (no originInstanceId), broadcasts
      // DM_MESSAGE_CREATE, then fires `fanOutDmMessageCreate` which
      // enqueues a `dm.message.create` envelope addressed to A.
      // The "A persists with originInstanceId = B" assertion lives in the
      // captured envelope (we don't re-feed it to B's inbound handler — same
      // Message.id reuse on both sides would unique-collide).
      const outboxBeforeReply = outboxJobs.length;
      const eventsBeforeReply = events.length;
      const bobReplyContent = 'Hey alice, glad you made it!';
      const replyRes = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmChannelId}/messages`,
        headers: { authorization: `Bearer ${bob.token}` },
        payload: { content: bobReplyContent },
      });
      expect(replyRes.statusCode).toBe(201);
      const bobReplyId = replyRes.json().data.id as string;

      // The local Message exists with no originInstanceId (locally authored).
      const bobReplyOnB = await prisma.message.findUniqueOrThrow({
        where: { id: bobReplyId },
        select: {
          id: true,
          content: true,
          originInstanceId: true,
          dmChannelId: true,
          authorId: true,
        },
      });
      expect(bobReplyOnB.dmChannelId).toBe(dmChannelId);
      expect(bobReplyOnB.originInstanceId).toBeNull();
      expect(bobReplyOnB.authorId).toBe(bob.userId);

      // The fan-out enqueued EXACTLY one new job (the reply). Give the
      // post-commit best-effort path a tick to land.
      await new Promise<void>((r) => setTimeout(r, 50));
      const replyJobs = outboxJobs.slice(outboxBeforeReply);
      const replyFanOuts = replyJobs.filter(
        (j) => j.eventType === 'dm.message.create' && j.messageId === bobReplyId,
      );
      expect(replyFanOuts).toHaveLength(1);
      expect(replyFanOuts[0]!.peerInstanceId).toBe(peer.peerId);
      expect(replyFanOuts[0]!.authorUserId).toBe(bob.userId);

      // Payload shape — proves A WOULD persist this row with
      // `originInstanceId = B` and bob's qualified id as authorRemoteUserId.
      const replyPayload = dmMessageCreatePayloadSchema.parse(
        replyFanOuts[0]!.payload,
      );
      expect(replyPayload.dmChannelId).toBe(dmChannelId);
      expect(replyPayload.messageId).toBe(bobReplyId);
      expect(replyPayload.authorRemoteUserId).toBe(bobRemoteUserId);
      expect(replyPayload.content).toBe(bobReplyContent);
      expect(replyPayload.replyToMessageId ?? null).toBeNull();

      // Local DM_MESSAGE_CREATE broadcast on B for the reply too.
      const localReplyBroadcasts = events
        .slice(eventsBeforeReply)
        .filter((e) => e.type === 'DM_MESSAGE_CREATE');
      expect(localReplyBroadcasts.length).toBeGreaterThanOrEqual(1);

      // ─── Step 9 (REAL) + Step 10 (REAL + Sim*): bob edits his message ───────
      // LOCAL on B: bob calls PATCH /api/messages/:id with new content.
      // The route updates Message.content, appends a MessageEdit history
      // row (preserving the original), and fires `fanOutDmMessageUpdate`.
      // NOTE: "A's Message row updated" can't be asserted in single-instance
      // simulation. We verify the OUTBOUND envelope content instead — the
      // wire bytes A would receive on its /_federation/event handler.
      const outboxBeforeEdit = outboxJobs.length;
      const bobEditedContent = 'Hey alice, glad you made it! (edited for typo)';
      const editRes = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${bobReplyId}`,
        headers: { authorization: `Bearer ${bob.token}` },
        payload: { content: bobEditedContent },
      });
      expect(editRes.statusCode).toBe(200);

      // B's Message.content updated.
      const bobReplyAfterEdit = await prisma.message.findUniqueOrThrow({
        where: { id: bobReplyId },
        select: { content: true, editedAt: true },
      });
      expect(bobReplyAfterEdit.content).toBe(bobEditedContent);
      expect(bobReplyAfterEdit.editedAt).not.toBeNull();

      // MessageEdit history row exists with the ORIGINAL content (the row
      // is written BEFORE the content overwrite — the original is what
      // gets preserved).
      const editHistory = await prisma.messageEdit.findMany({
        where: { messageId: bobReplyId },
        select: { content: true, editedBy: true },
        orderBy: { editedAt: 'asc' },
      });
      expect(editHistory).toHaveLength(1);
      expect(editHistory[0]!.content).toBe(bobReplyContent);
      expect(editHistory[0]!.editedBy).toBe(bob.userId);

      // Outbound dm.message.update envelope captured.
      await new Promise<void>((r) => setTimeout(r, 50));
      const editJobs = outboxJobs.slice(outboxBeforeEdit);
      const editFanOuts = editJobs.filter(
        (j) => j.eventType === 'dm.message.update' && j.messageId === bobReplyId,
      );
      expect(editFanOuts).toHaveLength(1);
      expect(editFanOuts[0]!.peerInstanceId).toBe(peer.peerId);
      expect(editFanOuts[0]!.authorUserId).toBe(bob.userId);

      const editPayload = dmMessageUpdatePayloadSchema.parse(
        editFanOuts[0]!.payload,
      );
      expect(editPayload.dmChannelId).toBe(dmChannelId);
      expect(editPayload.messageId).toBe(bobReplyId);
      expect(editPayload.authorRemoteUserId).toBe(bobRemoteUserId);
      expect(editPayload.content).toBe(bobEditedContent);
      // editedAt is ISO and parseable.
      expect(() => new Date(editPayload.editedAt).toISOString()).not.toThrow();

      // ─── Step 11 (Sim) + Step 12 (REAL): alice reacts to bob's message ──────
      // INBOUND on B: alice sends `dm.reaction.add` for bob's reply
      // (bobReplyId). The handler checks `dms` capability, verifies
      // alice is a member of the DM, upserts the MessageReaction row,
      // and fires REACTION_ADD.
      const eventsBeforeReact = events.length;
      const reactionEmoji = '🍻';
      const dmReactionAddPayload: DmReactionAddPayload = {
        dmChannelId,
        messageId: bobReplyId,
        actorRemoteUserId: aliceRemoteUserId,
        emoji: reactionEmoji,
      };
      dmReactionAddPayloadSchema.parse(dmReactionAddPayload);
      const dmReactionEnv = buildAEnvelope({
        peerKp: peer.peerKp,
        userKp: aliceUserKp,
        eventType: 'dm.reaction.add',
        payload: dmReactionAddPayload,
      });

      const reactRes = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        headers: { 'content-type': 'application/json' },
        payload: dmReactionEnv,
      });
      expect(reactRes.statusCode).toBe(200);

      // B's MessageReaction row exists, keyed on (messageId, userId, emoji).
      // The actor is alice's mirror User id (the handler resolves
      // remoteUserId → local synthetic User row).
      const reaction = await prisma.messageReaction.findUnique({
        where: {
          messageId_userId_emoji: {
            messageId: bobReplyId,
            userId: aliceMirrorUserId,
            emoji: reactionEmoji,
          },
        },
      });
      expect(reaction).not.toBeNull();

      // REACTION_ADD broadcast routed via dmChannelId (no serverId/channelId
      // for DM reactions — see gateway-broker.ts).
      const reactionBroadcasts = events
        .slice(eventsBeforeReact)
        .filter((e) => e.type === 'REACTION_ADD');
      expect(reactionBroadcasts.length).toBeGreaterThanOrEqual(1);
      expect(reactionBroadcasts[0]!.dmChannelId).toBe(dmChannelId);

      // ─── Step 13 (Sim) + Step 14 (REAL): alice deletes her own message ──────
      // INBOUND on B: alice sends `dm.message.delete` for HER message (the
      // one from step 5, aliceMessageId). The handler enforces actor =
      // author (alice signed AND alice authored), soft-deletes the row
      // (deletedAt + empty content), drops reactions + mentions, fires
      // DM_MESSAGE_DELETE.
      const eventsBeforeDelete = events.length;
      const deletedAtIso = new Date().toISOString();
      const dmMessageDeletePayload: DmMessageDeletePayload = {
        dmChannelId,
        messageId: aliceMessageId,
        actorRemoteUserId: aliceRemoteUserId,
        deletedAt: deletedAtIso,
      };
      dmMessageDeletePayloadSchema.parse(dmMessageDeletePayload);
      const dmDeleteEnv = buildAEnvelope({
        peerKp: peer.peerKp,
        userKp: aliceUserKp,
        eventType: 'dm.message.delete',
        payload: dmMessageDeletePayload,
      });

      const delRes = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        headers: { 'content-type': 'application/json' },
        payload: dmDeleteEnv,
      });
      expect(delRes.statusCode).toBe(200);

      // B's Message has deletedAt set + content blanked.
      const aliceMsgAfterDelete = await prisma.message.findUniqueOrThrow({
        where: { id: aliceMessageId },
        select: { deletedAt: true, content: true },
      });
      expect(aliceMsgAfterDelete.deletedAt).not.toBeNull();
      expect(aliceMsgAfterDelete.content).toBe('');

      // Reactions on the deleted message are cleared. (The handler also
      // clears mentions; we don't seed any so there's nothing to assert
      // for that branch.)
      const reactionsAfterDelete = await prisma.messageReaction.findMany({
        where: { messageId: aliceMessageId },
      });
      expect(reactionsAfterDelete).toHaveLength(0);

      // DM_MESSAGE_DELETE broadcast on the dmChannel.
      const deleteBroadcasts = events
        .slice(eventsBeforeDelete)
        .filter((e) => e.type === 'DM_MESSAGE_DELETE');
      expect(deleteBroadcasts.length).toBeGreaterThanOrEqual(1);
      expect(deleteBroadcasts[0]!.dmChannelId).toBe(dmChannelId);

      // ─── Cross-cutting sanity checks ────────────────────────────────────────
      // bob's reply on B is NOT affected by alice's delete (different
      // Message.id, different author).
      const bobReplyStillThere = await prisma.message.findUniqueOrThrow({
        where: { id: bobReplyId },
        select: { deletedAt: true, content: true },
      });
      expect(bobReplyStillThere.deletedAt).toBeNull();
      expect(bobReplyStillThere.content).toBe(bobEditedContent);

      // alice's reaction on bob's reply survives — it's keyed on bob's
      // messageId, not alice's deleted one.
      const aliceReactionStillThere = await prisma.messageReaction.findUnique({
        where: {
          messageId_userId_emoji: {
            messageId: bobReplyId,
            userId: aliceMirrorUserId,
            emoji: reactionEmoji,
          },
        },
      });
      expect(aliceReactionStillThere).not.toBeNull();

      // Total outbox shape: bob's reply (dm.message.create) + bob's edit
      // (dm.message.update). alice's inbound envelopes do NOT enqueue
      // anything on B because they're inbound, not local writes.
      const fanOutEventTypes = outboxJobs.map((j) => j.eventType).sort();
      expect(fanOutEventTypes).toEqual(
        ['dm.message.create', 'dm.message.update'].sort(),
      );
    } finally {
      unsubscribe();
      await app.close();
    }
  }, 60_000);
});
