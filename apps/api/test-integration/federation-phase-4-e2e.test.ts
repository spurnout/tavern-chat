/**
 * P4-17 — Federation Phase 4 end-to-end smoke test.
 *
 * The "Phase 4 done" gate. Exercises the full happy path that a real
 * deployment of two federated instances would take a user through:
 *
 *   1. Two instances (A, B) peer.
 *   2. A creates Tavern T (federated) with channel #general.
 *   3. A mints a federated `any_peer` invite for T.
 *   4. Alice on B accepts the invite.
 *   5. B mirrors T + #general and adds Alice as a member.
 *   6. A posts a message in #general; B receives it.
 *   7. Alice replies via her B-side mirror; A receives it.
 *   8. A renames #general → #lobby; B's mirror channel renames.
 *   9. Alice leaves the mirror; both sides clean up.
 *
 * ── DESIGN NOTE — single-instance simulation ──────────────────────────────
 *
 * A truly two-process E2E setup (two `buildApp` instances + two Postgres
 * containers) is structurally blocked by two design choices that ship with
 * Phase 4 itself:
 *
 *   - The mirror Server row on B uses the SAME `id` as the home Server on A
 *     (see `services/federation-mirror.ts` :: `createMirrorServer`).
 *     A single shared Postgres rejects the duplicate id; two Postgres
 *     instances would each need their own `@tavern/db` Prisma singleton,
 *     but `buildApp` reads `prisma` via a module-level import — there's no
 *     per-app override.
 *   - The federation outbox dispatcher (`packages/federation/.../outbox-
 *     dispatcher.ts`) imports the same Prisma singleton, so it cannot be
 *     pointed at a different DB without forking the federation package's
 *     internal wiring.
 *
 * Rather than build a second Prisma singleton (out of scope for this test
 * and risks subtle bugs that would be invisible until production), we run
 * with ONE Postgres + ONE Fastify app from B's perspective and SIMULATE
 * instance A entirely with hand-crafted signed envelopes + a captured
 * outbox queue. Every B-side line of code that ships in Phase 4 — the
 * invite-accept route, the inbound `/_federation/event` handler dispatch,
 * the mirror channel post fan-out, the leave-mirror route — runs as it
 * would in production. The A side is reduced to "what would A produce on
 * the wire" and "what would A persist on receipt", both of which we assert
 * structurally via the captured envelopes.
 *
 * Mapping vs the P4-17 spec's 13 assertions:
 *
 *   ┌──────┬──────────────────────────────────────────────────────┬─────────┐
 *   │ Step │ Assertion                                            │ Style   │
 *   ├──────┼──────────────────────────────────────────────────────┼─────────┤
 *   │   1  │ A and B peered (RemoteInstance rows seeded on B)     │ Sim     │
 *   │   2  │ A has Tavern T with federationEnabled=true + channel │ Sim     │
 *   │   3  │ A minted invite with remoteScope=any_peer            │ Sim     │
 *   │   4  │ B's accept route runs; envelope dispatch verifies    │ REAL    │
 *   │   5  │ B has mirror Server T + #general; alice is a member  │ REAL    │
 *   │   6  │ A posts a message in #general                        │ Sim     │
 *   │   7  │ B's message row exists with originInstanceId = A     │ REAL    │
 *   │      │ + MESSAGE_CREATE gateway broadcast fires             │ REAL    │
 *   │   8  │ Alice posts a reply in the mirror #general           │ REAL    │
 *   │   9  │ A's message row exists with originInstanceId = B     │ Sim*    │
 *   │  10  │ A renames #general to #lobby                         │ Sim     │
 *   │  11  │ B's mirror channel renames; CHANNEL_UPDATE fires     │ REAL    │
 *   │  12  │ Alice leaves the mirror server                       │ REAL    │
 *   │  13  │ B no longer has the mirror; A's ServerMember is gone │ REAL/Sim│
 *   └──────┴──────────────────────────────────────────────────────┴─────────┘
 *
 *   Sim   = constructed/asserted via envelope content the test built itself.
 *   REAL  = runs through the actual Fastify route or inbound dispatcher.
 *   Sim*  = step 9 is asserted by inspecting the `message.create` envelope
 *           that the B-side route enqueued on the outbox: it carries the
 *           correct `authorRemoteUserId=alice@b.example` and would be
 *           consumed by A's `/_federation/event` handler — the same code
 *           path step 7 exercised in the opposite direction. We do not
 *           re-feed it through the inbound handler because that would
 *           collide with the existing Message row (same id).
 *
 * Things this test deliberately does NOT cover (they live in dedicated
 * integration files):
 *   - Peering handshake mechanics (`federation-peering.test.ts`)
 *   - Profile resolution edge cases (`federation-profile-*.test.ts`)
 *   - Replay window / signature verification failures (`federation-inbound.test.ts`)
 *   - Per-channel `federationMode` overrides (`channel-federation-mode.test.ts`)
 *   - Outbox dispatcher retries / fetch error paths (`federation-outbox.test.ts`)
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
import type { PrismaClient } from '@prisma/client';
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
  ENVELOPE_DEFAULT_LIFETIME_S,
  PROTOCOL_VERSION,
  channelUpdatePayloadSchema,
  messageCreatePayloadSchema,
  ulid,
  type ChannelUpdatePayload,
  type MemberJoinRequestPayload,
  type MemberJoinedPayload,
  type MemberLeavePayload,
  type MemberRemovedPayload,
  type MessageCreatePayload,
  type ServerSnapshot,
} from '@tavern/shared';
import {
  buildTwoLayerMessageEnvelope,
  canonicalize,
  exportPublicKeyRaw,
  generateKeyPair,
  publicKeyFromRaw,
  sign as edSign,
  verify as edVerify,
  type FederationOutboxJob,
  type PostFederationEventSyncFn,
  type SingleLayerSignedEnvelope,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import type { QueueClient } from '../src/services/queues.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';
import { gatewayBroker } from '../src/services/gateway-broker.js';

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

// B is the instance under test (the receiving / mirror side of the flow).
const B_HOST = 'b.example';
// A is the peer that owns Tavern T; simulated via hand-crafted envelopes.
const A_HOST = 'a.example';
// Constant invite code; A_HOST is the issuer.
const INVITE_CODE = 'PHASE4SMOKE01';

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${B_HOST}`,
  } as NodeJS.ProcessEnv;
}

/**
 * Mint a local B-side user + Session so we can drive authenticated routes via
 * `app.inject`. Returns the user id, the canonical username (used to form the
 * qualified `localpart@b.example`), and the JWT.
 */
async function makeLocalUser(opts?: { usernamePrefix?: string }): Promise<{
  userId: string;
  username: string;
  token: string;
}> {
  const userId = ulid();
  const sessionId = ulid();
  const prefix = opts?.usernamePrefix ?? 'alice';
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

interface PeerSeed {
  /** RemoteInstance.id assigned at seed time. */
  peerId: string;
  /** Instance keypair for A — used to sign all simulated A→B envelopes. */
  peerKp: ReturnType<typeof generateKeyPair>;
}

/**
 * Seed a peered RemoteInstance row for A in B's DB. The keypair we generate
 * here doubles as A's "instance key": A signs envelopes with `peerKp.privateKey`,
 * and B verifies them against the public key we stored in `instanceKey`.
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
      capabilities: ['messages', 'mirror'],
      peeredAt: new Date(),
    },
  });
  return { peerId, peerKp };
}

/**
 * Pre-populate a RemoteUser cache row for a remote member of T (e.g. alice as
 * she's seen FROM B's perspective on A's home server — used by the message.create
 * inbound handler to verify signatures without a profile fetch over the wire).
 * Stores a fresh ed25519 keypair so the test can sign payloads on behalf of
 * that user.
 */
async function seedRemoteUser(opts: {
  peerId: string;
  remoteUserId: string;
  displayName?: string;
}): Promise<{ userKp: ReturnType<typeof generateKeyPair> }> {
  const userKp = generateKeyPair();
  await prisma.remoteUser.upsert({
    where: { remoteUserId: opts.remoteUserId },
    create: {
      id: ulid(),
      remoteInstanceId: opts.peerId,
      remoteUserId: opts.remoteUserId,
      displayNameCache: opts.displayName ?? opts.remoteUserId,
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
 * Build a single-layer signed `member.joined` reply as A would return it to
 * B's `member.join_request`. Carries the server snapshot the mirror service
 * will materialise.
 */
function buildJoinedReply(
  peerKp: ReturnType<typeof generateKeyPair>,
  inviteCode: string,
  snapshot: ServerSnapshot,
): SingleLayerSignedEnvelope<MemberJoinedPayload> {
  const payload: MemberJoinedPayload = { inviteCode, serverSnapshot: snapshot };
  return signSingleLayer(peerKp, 'member.joined', payload);
}

/**
 * Build a single-layer signed `member.removed` reply as A would return it to
 * B's `member.leave`.
 */
function buildRemovedReply(
  peerKp: ReturnType<typeof generateKeyPair>,
  payload: MemberRemovedPayload,
): SingleLayerSignedEnvelope<MemberRemovedPayload> {
  return signSingleLayer(peerKp, 'member.removed', payload);
}

function signSingleLayer<TPayload>(
  peerKp: ReturnType<typeof generateKeyPair>,
  eventType:
    | 'member.joined'
    | 'member.removed',
  payload: TPayload,
): SingleLayerSignedEnvelope<TPayload> {
  const now = Date.now();
  const unsigned = {
    version: PROTOCOL_VERSION,
    eventType,
    nonce: ulid(),
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + ENVELOPE_DEFAULT_LIFETIME_S * 1000).toISOString(),
    fromInstance: A_HOST,
    toInstance: B_HOST,
    payload,
  };
  const sig = edSign(
    Buffer.from(canonicalize(unsigned as unknown), 'utf8'),
    peerKp.privateKey,
  );
  return {
    ...unsigned,
    signature: sig.toString('base64'),
  } as SingleLayerSignedEnvelope<TPayload>;
}

/**
 * Build a two-layer signed envelope SIGNED BY A (instance + user). Used to
 * simulate the actual envelopes A would POST to B's `/_federation/event`
 * during steps 6 (message.create from alice on A) and 10 (channel.update
 * from A's owner).
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
 * Wipe the DB between tests. Order matters because of FK cascades; this
 * mirrors the pattern used by the other Phase-4 integration files.
 */
async function reset(): Promise<void> {
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.invite.deleteMany({});
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
 * dispatching. The captured jobs are introspected in steps 8 and 13 to
 * verify the envelope shape B emits back to A.
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

describe.skipIf(!dockerOk)('Federation Phase 4 — end-to-end smoke', () => {
  beforeEach(async () => {
    await reset();
  });

  it('happy path: peer → mirror invite → message round-trip → rename → leave', async () => {
    // ─── Step 1 (Sim): A and B are peered ─────────────────────────────────────
    // On B's side this is a RemoteInstance row for A in status='peered'.
    // The real two-instance handshake is exercised in `federation-peering.test.ts`.
    const peer = await seedPeer(A_HOST);

    // ─── Step 2 (Sim): A has Tavern T with federationEnabled and #general ────
    // We commit to the ids A would assign so the simulated envelopes below
    // line up. The snapshot returned by the simulated A→B `member.joined`
    // ack (step 4) carries these same ids; B's mirror service stores the
    // mirror under the same Server.id (Phase 4 design — see federation-
    // mirror.ts).
    const serverIdOnA = ulid();
    const channelIdOnA = ulid();
    const aliceLocalpart = 'alice';
    const aliceRemoteUserId = `${aliceLocalpart}@${A_HOST}`;

    // Pre-seed the RemoteUser row for the owner of T on A's side (Alice acts
    // as the home owner in this scenario — single-user smoke test simplifies
    // the snapshot). The `userKp` returned is the same key A would publish via
    // .well-known, and we use it to sign the message.create envelope in step 6.
    const { userKp: aliceUserKp } = await seedRemoteUser({
      peerId: peer.peerId,
      remoteUserId: aliceRemoteUserId,
      displayName: 'Alice',
    });

    // ─── Step 3 (Sim): A mints `any_peer` invite for T ───────────────────────
    // No DB row needed on B — the invite lives only on A. INVITE_CODE is the
    // shared identifier B will POST to /api/federation/invites/:code/accept.

    // ─── Boot B with FEDERATION_ENABLED ─────────────────────────────────────
    // The sync-dispatch override stands in for any HTTP B would make to A.
    // We capture every outbound envelope (the join_request in step 4 and the
    // leave in step 12), pull the payload, and synthesise A's signed reply.
    type SentSync = {
      envelope: TwoLayerSignedEnvelope<unknown>;
      eventType: string;
    };
    const syncSends: SentSync[] = [];

    const dispatch: PostFederationEventSyncFn = async (input) => {
      const env = input.envelope as TwoLayerSignedEnvelope<unknown>;
      syncSends.push({ envelope: env, eventType: env.eventType });

      if (env.eventType === 'member.join_request') {
        const reqPayload = env.payload as MemberJoinRequestPayload;
        // ── Synthesise the snapshot A would send back ──
        // After A accepts the invite, A's snapshot would carry T + #general +
        // alice (the owner) as the sole member. The joiner herself is NOT in
        // the snapshot — the route adds her as a local ServerMember
        // post-snapshot (see federation-invites-accept.ts step 6c).
        const snapshot: ServerSnapshot = {
          serverId: serverIdOnA,
          ownerRemoteUserId: aliceRemoteUserId,
          name: 'Federated Tavern',
          description: 'The Phase 4 smoke test tavern.',
          iconUrl: null,
          federationEnabled: true,
          channels: [
            {
              id: channelIdOnA,
              name: 'general',
              type: 'text',
              topic: null,
              position: 0,
              federationMode: 'inherit',
              nsfw: false,
            },
          ],
          members: [
            {
              remoteUserId: aliceRemoteUserId,
              displayName: 'Alice',
              joinedAt: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
        };
        const reply = buildJoinedReply(peer.peerKp, reqPayload.inviteCode, snapshot);
        return { ok: true, payload: reply.payload as never };
      }

      if (env.eventType === 'member.leave') {
        const reqPayload = env.payload as MemberLeavePayload;
        // ── Synthesise the `member.removed` ack ──
        const reply = buildRemovedReply(peer.peerKp, {
          serverId: reqPayload.serverId,
          leaverRemoteUserId: reqPayload.leaverRemoteUserId,
        });
        return { ok: true, payload: reply.payload as never };
      }

      // The smoke test never expects any other sync event type. Failing
      // hard here surfaces a wiring drift between the route layer and the
      // simulation, rather than silently returning a 4xx the test would
      // attribute to the route under test.
      throw new Error(`unexpected sync dispatch: ${env.eventType}`);
    };

    // Outbox capture: every `message.create`, `channel.update`, `member.remove`
    // etc. that B's local routes enqueue gets stored here for assertion.
    const { queue, jobs: outboxJobs } = makeCapturingQueue();

    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      federationSyncDispatchOverride: dispatch,
      queuesOverride: queue,
    });

    // Gateway broker observer — used to assert SERVER_ADD (step 5),
    // MESSAGE_CREATE (step 7), CHANNEL_UPDATE (step 11), SERVER_REMOVE (step 13).
    const events: Array<{
      type: string;
      userId?: string;
      serverId?: string;
      channelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      // ─── Mint Alice on B ─────────────────────────────────────────────────────
      // Alice is a LOCAL user on B who will accept the invite minted on A.
      // Her qualified id is `${alice.username}@b.example`.
      const alice = await makeLocalUser({ usernamePrefix: 'alice' });

      // ─── Step 4 (REAL): Alice on B accepts A's invite ───────────────────────
      const acceptRes = await app.inject({
        method: 'POST',
        url: `/api/federation/invites/${INVITE_CODE}/accept`,
        headers: { authorization: `Bearer ${alice.token}` },
        payload: { remoteInstanceHost: A_HOST },
      });
      expect(acceptRes.statusCode).toBe(200);
      const acceptBody = acceptRes.json();
      expect(acceptBody.ok).toBe(true);
      expect(acceptBody.data).toMatchObject({
        serverId: serverIdOnA,
        mirrored: true,
        alreadyMember: false,
      });

      // The accept route DID dispatch exactly one sync envelope — the
      // join_request. Validate its shape so step 4 is exercised end-to-end
      // and not just "the response came back ok".
      expect(syncSends).toHaveLength(1);
      const joinReqEnv = syncSends[0]!.envelope;
      expect(joinReqEnv.eventType).toBe('member.join_request');
      expect(joinReqEnv.fromInstance).toBe(B_HOST);
      expect(joinReqEnv.toInstance).toBe(A_HOST);
      const joinPayload = joinReqEnv.payload as MemberJoinRequestPayload;
      expect(joinPayload.inviteCode).toBe(INVITE_CODE);
      expect(joinPayload.joinerRemoteUserId).toBe(`${alice.username}@${B_HOST}`);

      // ─── Step 5 (REAL): B has mirror T + #general; alice is a member ────────
      const mirrorServer = await prisma.server.findUniqueOrThrow({
        where: { id: serverIdOnA },
        select: {
          id: true,
          name: true,
          federationEnabled: true,
          originInstanceId: true,
          defaultRoleId: true,
        },
      });
      expect(mirrorServer.originInstanceId).toBe(peer.peerId);
      expect(mirrorServer.federationEnabled).toBe(true);
      expect(mirrorServer.name).toBe('Federated Tavern');
      expect(mirrorServer.defaultRoleId).not.toBeNull();

      const mirrorChannel = await prisma.channel.findUniqueOrThrow({
        where: { id: channelIdOnA },
        select: {
          id: true,
          serverId: true,
          name: true,
          originInstanceId: true,
          federationMode: true,
        },
      });
      expect(mirrorChannel.serverId).toBe(serverIdOnA);
      expect(mirrorChannel.name).toBe('general');
      expect(mirrorChannel.originInstanceId).toBe(peer.peerId);

      // Alice the LOCAL user is now a ServerMember of the mirror.
      const aliceMembership = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: serverIdOnA, userId: alice.userId } },
      });
      expect(aliceMembership).not.toBeNull();

      // SERVER_ADD addressed to Alice fired post-commit.
      const serverAdds = events.filter((e) => e.type === 'SERVER_ADD');
      expect(serverAdds.length).toBe(1);
      expect(serverAdds[0]!.userId).toBe(alice.userId);

      // ─── Step 6 (Sim) + Step 7 (REAL): A posts in #general; B receives ──────
      // Build a `message.create` envelope as if A's home posted it. The
      // author is alice@a.example (synthetic — represents the owner of T on
      // A; in our smoke scenario she's also the only A-side user). Post it
      // to B's inbound endpoint and watch the full handler chain run.
      const messageFromAId = ulid();
      const messageFromAContent = 'hello peers, alice@A speaking';
      const messageFromACreatedAt = new Date().toISOString();
      const messageCreatePayload: MessageCreatePayload = {
        authorRemoteUserId: aliceRemoteUserId,
        channelId: channelIdOnA,
        messageId: messageFromAId,
        content: messageFromAContent,
        replyToMessageId: null,
        createdAt: messageFromACreatedAt,
      };
      // Defensive schema parse — the envelope builder doesn't validate the
      // payload itself, so if the wire shape ever drifts we want this test
      // to flag it at construction, not at inbound rejection.
      messageCreatePayloadSchema.parse(messageCreatePayload);
      const messageEnv = buildAEnvelope({
        peerKp: peer.peerKp,
        userKp: aliceUserKp,
        eventType: 'message.create',
        payload: messageCreatePayload,
      });

      // Snapshot the event count so we can assert the gateway broadcast
      // came from THIS envelope and not from step 5.
      const eventsBeforeIngest = events.length;
      const ingestRes = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        headers: { 'content-type': 'application/json' },
        payload: messageEnv,
      });
      expect(ingestRes.statusCode).toBe(200);

      // B's DB has the new Message row with the right origin.
      const messageOnB = await prisma.message.findUniqueOrThrow({
        where: { id: messageFromAId },
        select: {
          id: true,
          channelId: true,
          content: true,
          originInstanceId: true,
          authorId: true,
        },
      });
      expect(messageOnB.channelId).toBe(channelIdOnA);
      expect(messageOnB.content).toBe(messageFromAContent);
      expect(messageOnB.originInstanceId).toBe(peer.peerId);
      // The author is the synthetic local-User row that wraps alice@a.example
      // (materialised by `ensureUserForRemoteUser` inside the inbound handler).
      const aliceSyntheticOnB = await prisma.user.findUniqueOrThrow({
        where: { remoteUserId: aliceRemoteUserId },
        select: { id: true },
      });
      expect(messageOnB.authorId).toBe(aliceSyntheticOnB.id);

      // MESSAGE_CREATE gateway broadcast fired on the channel. (The broker
      // event-type is named MESSAGE_CREATE; the SPA renders it as a new
      // message — see `services/gateway-broker.ts` and `gateway/index.ts`.)
      const messageCreates = events
        .slice(eventsBeforeIngest)
        .filter((e) => e.type === 'MESSAGE_CREATE');
      expect(messageCreates.length).toBeGreaterThanOrEqual(1);
      expect(messageCreates[0]!.channelId).toBe(channelIdOnA);

      // ─── Step 8 (REAL) + Step 9 (Sim*): Alice replies via her B mirror ──────
      // The reply travels back through B's existing `POST /api/channels/:id/
      // messages` route. Because the channel is a MIRROR (originInstanceId is
      // set), the fan-out helper targets ONLY the home (peer A) — exactly the
      // P4-14 behaviour. We inspect the outbox queue rather than re-feeding
      // the envelope through the inbound handler because doing so would
      // collide with the Message row Alice just wrote on B (same id reused
      // on both sides — federation Phase 3 design).
      const outboxBeforeReply = outboxJobs.length;
      const replyRes = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelIdOnA}/messages`,
        headers: { authorization: `Bearer ${alice.token}` },
        payload: { content: 'hi back from B, alice@B speaking' },
      });
      expect(replyRes.statusCode).toBe(201);
      const replyId = replyRes.json().data.id as string;

      // The Message row exists on B with no originInstanceId (local create).
      const replyOnB = await prisma.message.findUniqueOrThrow({
        where: { id: replyId },
        select: { id: true, content: true, originInstanceId: true, channelId: true },
      });
      expect(replyOnB.channelId).toBe(channelIdOnA);
      expect(replyOnB.originInstanceId).toBeNull();

      // The fan-out enqueued EXACTLY one job, to peer A (the channel's home).
      // Give the post-commit best-effort fan-out a tick to land.
      await new Promise<void>((r) => setTimeout(r, 50));
      const replyJobs = outboxJobs.slice(outboxBeforeReply);
      const replyFanOuts = replyJobs.filter(
        (j) => j.eventType === 'message.create' && j.messageId === replyId,
      );
      expect(replyFanOuts).toHaveLength(1);
      expect(replyFanOuts[0]!.peerInstanceId).toBe(peer.peerId);

      // Payload shape — proves the envelope A WOULD persist with
      // `originInstanceId = B` carries the right wire fields.
      const replyPayload = messageCreatePayloadSchema.parse(replyFanOuts[0]!.payload);
      expect(replyPayload.authorRemoteUserId).toBe(`${alice.username}@${B_HOST}`);
      expect(replyPayload.channelId).toBe(channelIdOnA);
      expect(replyPayload.messageId).toBe(replyId);
      expect(replyPayload.content).toBe('hi back from B, alice@B speaking');
      // No replyToMessageId because the SPA omitted it; the route normalises
      // missing → null/undefined.
      expect(replyPayload.replyToMessageId ?? null).toBeNull();

      // ─── Step 10 (Sim) + Step 11 (REAL): A renames #general → #lobby ────────
      // Construct a `channel.update` envelope as A would emit on their PATCH
      // /api/channels/:id name flow. POST to B's `/_federation/event` and
      // verify the mirror channel's name flips + a CHANNEL_UPDATE fires.
      // The channel.update payload doesn't carry an explicit author field —
      // the inbound handler looks the owner up via `resolveMirrorOwner`
      // (which keys on the mirror Server's local owner row → its
      // `remoteUserId`). The user-layer signature must verify against THAT
      // owner's public key; we already seeded Alice as the owner above and
      // her keypair is `aliceUserKp`, so the envelope wired below verifies.
      const channelUpdatePayload: ChannelUpdatePayload = {
        serverId: serverIdOnA,
        channelId: channelIdOnA,
        name: 'lobby',
        // Other patch fields omitted → wire-schema-optional, preserved as-is.
      };
      channelUpdatePayloadSchema.parse(channelUpdatePayload);
      const renameEnv = buildAEnvelope({
        peerKp: peer.peerKp,
        userKp: aliceUserKp,
        eventType: 'channel.update',
        payload: channelUpdatePayload,
      });

      const eventsBeforeRename = events.length;
      const renameRes = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        headers: { 'content-type': 'application/json' },
        payload: renameEnv,
      });
      expect(renameRes.statusCode).toBe(200);

      const renamed = await prisma.channel.findUniqueOrThrow({
        where: { id: channelIdOnA },
        select: { name: true, serverId: true, originInstanceId: true },
      });
      expect(renamed.name).toBe('lobby');
      expect(renamed.originInstanceId).toBe(peer.peerId);

      const channelUpdates = events
        .slice(eventsBeforeRename)
        .filter((e) => e.type === 'CHANNEL_UPDATE');
      expect(channelUpdates.length).toBeGreaterThanOrEqual(1);
      expect(channelUpdates[0]!.serverId).toBe(serverIdOnA);
      expect(channelUpdates[0]!.channelId).toBe(channelIdOnA);

      // ─── Step 12 (REAL) + Step 13 (REAL/Sim): Alice leaves the mirror ───────
      // The leave route dispatches a `member.leave` envelope via our stubbed
      // sync impl; the stub returns a signed `member.removed` ack. After the
      // ack B deletes Alice's ServerMember row — and since she was the only
      // local member, also tears the mirror down.
      const syncSendsBeforeLeave = syncSends.length;
      const eventsBeforeLeave = events.length;
      const leaveRes = await app.inject({
        method: 'POST',
        url: `/api/federation/mirror-servers/${serverIdOnA}/leave`,
        headers: { authorization: `Bearer ${alice.token}` },
      });
      expect(leaveRes.statusCode).toBe(200);
      const leaveBody = leaveRes.json();
      expect(leaveBody.data).toMatchObject({
        serverId: serverIdOnA,
        mirrorTornDown: true,
      });

      // The mirror Server is gone on B (cascade also clears Channel + Role +
      // ServerMember). Asserts (step 13a).
      const serverAfterLeave = await prisma.server.findUnique({
        where: { id: serverIdOnA },
      });
      expect(serverAfterLeave).toBeNull();
      const channelAfterLeave = await prisma.channel.findUnique({
        where: { id: channelIdOnA },
      });
      expect(channelAfterLeave).toBeNull();
      const aliceMembershipAfter = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: serverIdOnA, userId: alice.userId } },
      });
      expect(aliceMembershipAfter).toBeNull();

      // SERVER_REMOVE addressed to Alice fired post-commit.
      const serverRemoves = events
        .slice(eventsBeforeLeave)
        .filter((e) => e.type === 'SERVER_REMOVE');
      expect(serverRemoves).toHaveLength(1);
      expect(serverRemoves[0]!.userId).toBe(alice.userId);

      // The leave dispatched exactly one new sync envelope.
      const leaveSyncs = syncSends.slice(syncSendsBeforeLeave);
      expect(leaveSyncs).toHaveLength(1);
      const leaveEnv = leaveSyncs[0]!.envelope;
      expect(leaveEnv.eventType).toBe('member.leave');
      expect(leaveEnv.fromInstance).toBe(B_HOST);
      expect(leaveEnv.toInstance).toBe(A_HOST);
      const leavePayload = leaveEnv.payload as MemberLeavePayload;
      expect(leavePayload.serverId).toBe(serverIdOnA);
      expect(leavePayload.leaverRemoteUserId).toBe(`${alice.username}@${B_HOST}`);
      // Step 13b — the envelope above is what A would receive on
      // `/_federation/event`. Its `member.leave` handler does
      // `serverMember.delete` keyed on (serverId, leaverRemoteUserId), which
      // is precisely the "A's ServerMember row for alice is gone" assertion.
      // We do not re-feed the envelope through B's own inbound handler
      // because (a) the mirror's been torn down so the handler would 404
      // with `unknown_mirror_server` and (b) the assertion is on A's side
      // not B's. The structural proof — A would persist this delete —
      // lives in the captured envelope.

      // ─── Cross-cutting sanity checks ───────────────────────────────────────
      // No surprise envelopes the test didn't account for.
      expect(syncSends.map((s) => s.eventType).sort()).toEqual(
        ['member.join_request', 'member.leave'].sort(),
      );

      // Verify B's outbound envelopes really are signed by B's instance key —
      // closes the loop on the user-and-instance two-layer signature path.
      // The accept route built the join_request inside B; verify it carries
      // a valid layer-2 signature against B's published instance key.
      const bInstanceKeyRow = await prisma.federationKey.findFirstOrThrow({
        where: { isCurrent: true },
      });
      const bInstancePub = publicKeyFromRaw(Buffer.from(bInstanceKeyRow.publicKey));
      for (const sent of syncSends) {
        const { signature, ...unsigned } = sent.envelope;
        const envBytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
        const sigBytes = Buffer.from(signature, 'base64');
        expect(
          edVerify(envBytes, sigBytes, bInstancePub),
        ).toBe(true);
      }
    } finally {
      unsubscribe();
      await app.close();
    }
  }, 60_000);
});
