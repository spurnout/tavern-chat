/**
 * P6-10 — Federation Phase 6 end-to-end smoke test.
 *
 * The "Phase 6 done" gate. Exercises the full happy path that a real
 * two-instance deployment with the `presence` capability would take through:
 *
 *   1. Two instances (A, B) are peered with `messages` + `presence`
 *      capabilities on both sides.
 *   2. alice on A is a remote-user mirror on B; bob on B is local; both are
 *      members of a federated Tavern T (the surface that justifies fan-out).
 *   3. alice transitions to `idle` on her home — A signs and dispatches a
 *      `presence.update` envelope to B. B's mirror flips to idle.
 *   4. alice sets a custom status with +1h expiry. B's mirror reflects.
 *   5. alice's last socket disconnects → presence flips to `offline` on B.
 *   6. alice clears her custom status. B's mirror's customStatus + expiry
 *      go null again.
 *   7. Authority check: peer C tries to assert alice's presence. 403
 *      `not_home_instance`; B's mirror untouched.
 *   8. Watermark check: A replays an OLD presence.update with an earlier
 *      `updatedAt`. Handler returns 200 `skipped: stale`; mirror untouched.
 *   9. Capability gate: B is rebuilt with `FEDERATION_PRESENCE_ENABLED=false`.
 *      The same valid envelope from A is now rejected with 403
 *      `presence_capability_missing` BEFORE any signature work.
 *
 * ── DESIGN NOTE — single-instance simulation ──────────────────────────────
 *
 * Same calculus as Phase 4-17 and Phase 5-12: a truly two-process E2E setup
 * is structurally blocked by Phase 3-4 design choices (shared row ids across
 * sides, module-level Prisma singleton in `@tavern/db`). Phase 6 adds no new
 * Prisma migration and no new sharing rules, so the calculus is unchanged.
 *
 * The test runs with ONE Postgres + ONE Fastify app from B's perspective and
 * SIMULATES instance A entirely with hand-crafted, instance-key-signed
 * envelopes. Every B-side line of code that ships in Phase 6 — the inbound
 * `/_federation/event` dispatcher branch for `presence.update`, the
 * single-layer verifier path, `handlePresenceUpdate` with its authority and
 * watermark checks, the operator-level capability gate — runs as it would
 * in production. The A side is reduced to "what would A produce on the
 * wire", which we assert structurally via the envelopes we construct.
 *
 * Mapping vs the P6-10 spec's 13 steps:
 *
 *   ┌──────┬───────────────────────────────────────────────────────┬─────────┐
 *   │ Step │ Assertion                                             │ Style   │
 *   ├──────┼───────────────────────────────────────────────────────┼─────────┤
 *   │  1-2 │ A and B peered + both members of federated Tavern T   │ Sim     │
 *   │  3-4 │ alice → idle; B's mirror updated; PRESENCE_UPDATE     │ REAL    │
 *   │  5-6 │ alice sets custom status; B's mirror reflects         │ REAL    │
 *   │  7   │ alice goes offline; B's mirror reflects `offline`     │ REAL    │
 *   │ 9-10 │ alice clears custom status; B's mirror clears both    │ REAL    │
 *   │  11  │ Authority — peer C asserts alice → 403                │ REAL    │
 *   │  12  │ Watermark — stale replay → 200 `skipped: stale`       │ REAL    │
 *   │  13  │ Capability gate — env flag off → 403                  │ REAL    │
 *   └──────┴───────────────────────────────────────────────────────┴─────────┘
 *
 *   Sim   = pure setup via DB seeding (peer rows, mirror users, server).
 *   REAL  = exercises the actual inbound dispatcher + handlers.
 *
 * Steps 3, 5, 7 are "Sim" on the OUTBOUND side (we don't drive
 * `presence-service.ts` on the simulated A — that's covered exhaustively in
 * `federation-presence-fanout.test.ts`). What's REAL here is B's inbound
 * processing, which is the half of the Phase 6 wire path that this E2E gate
 * needs to certify.
 *
 * Things this test deliberately does NOT cover (covered elsewhere):
 *   - Outbound fan-out + debounce mechanics (`federation-presence-fanout.test.ts`)
 *   - Per-event-type inbound handler edge cases — unknown user, bad
 *     signature, replay (`federation-inbound.test.ts` P6-7 block)
 *   - `findPresenceFanOutPeers` query shapes
 *     (`federation-presence-targets.test.ts`)
 *   - The local PATCH /api/me/presence custom-status API
 *     (`presence-custom-status.test.ts`)
 *   - well-known capability filtering (`well-known-capabilities.test.ts`)
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { type PrismaClient, Prisma } from '@prisma/client';
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
  federatedPresenceUpdatePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  exportPublicKeyRaw,
  generateKeyPair,
  sign as edSign,
} from '@tavern/federation';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { gatewayBroker } from '../src/services/gateway-broker.js';
import { buildSignedEnvelope } from '../src/services/federation-envelopes.js';

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

// B is the instance under test (alice's mirror lives here, bob is local).
const B_HOST = 'b.example';
// A is the peer that owns alice; simulated via hand-crafted envelopes.
const A_HOST = 'a.example';
// C is a third peer used only for the authority check (step 11).
const C_HOST = 'c.example';

function envFor(opts: {
  dbUrl: string;
  presenceEnabled?: boolean;
}): NodeJS.ProcessEnv {
  const out: Record<string, string> = {
    DATABASE_URL: opts.dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${B_HOST}`,
  };
  if (opts.presenceEnabled !== undefined) {
    out.FEDERATION_PRESENCE_ENABLED = opts.presenceEnabled ? 'true' : 'false';
  }
  return out as NodeJS.ProcessEnv;
}

interface PeerSeed {
  /** RemoteInstance.id assigned at seed time. */
  peerId: string;
  /** Peer host (alias for inspection). */
  host: string;
  /** Instance keypair — used to sign every simulated peer→B envelope. */
  peerKp: ReturnType<typeof generateKeyPair>;
}

/**
 * Seed a peered RemoteInstance row for a peer in B's DB. Default capabilities
 * include `presence` so the gates pass; callers can pass a leaner set for the
 * negative-path tests covered in `federation-inbound.test.ts`.
 */
async function seedPeer(
  host: string,
  capabilities: string[] = ['messages', 'presence'],
): Promise<PeerSeed> {
  const peerKp = generateKeyPair();
  const peerId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host,
      instanceKey: exportPublicKeyRaw(peerKp.publicKey),
      status: 'peered',
      capabilities,
      peeredAt: new Date(),
    },
  });
  return { peerId, host, peerKp };
}

interface MirrorUserSeed {
  localUserId: string;
  remoteUserId: string;
  initialPresenceUpdatedAt: Date;
}

/**
 * Materialise the local synthetic User row that mirrors a remote user on B
 * (`remoteInstanceId != null`). The `presence.update` inbound handler looks
 * up this row by `remoteUserId` and overwrites the presence + customStatus
 * fields on it.
 */
async function seedMirrorUser(opts: {
  peer: PeerSeed;
  localpart: string;
  initialPresence?: 'active' | 'idle' | 'dnd' | 'offline';
  initialPresenceUpdatedAt?: Date;
}): Promise<MirrorUserSeed> {
  const remoteUserId = `${opts.localpart}@${opts.peer.host}`;
  const localUserId = ulid();
  const syntheticUsername = `__rem_${localUserId.toLowerCase()}`;
  const initialPresenceUpdatedAt =
    opts.initialPresenceUpdatedAt ?? new Date('2026-01-01T00:00:00.000Z');

  // RemoteUser cache row — `lastSeenAt` is touched post-commit by the
  // handler. We seed at epoch 0 so the touch is observable.
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: opts.peer.peerId,
      remoteUserId,
      displayNameCache: opts.localpart,
      avatarUrlCache: null,
      publicKey: randomBytes(32),
      lastSeenAt: new Date(0),
    },
  });
  await prisma.user.create({
    data: {
      id: localUserId,
      username: syntheticUsername,
      usernameLower: syntheticUsername,
      displayName: opts.localpart,
      email: `${localUserId.toLowerCase()}@${opts.peer.host}.federated.local`,
      emailLower: `${localUserId.toLowerCase()}@${opts.peer.host}.federated.local`,
      passwordHash: null,
      remoteUserId,
      remoteInstanceId: opts.peer.peerId,
      presence: opts.initialPresence ?? 'offline',
      presenceUpdatedAt: initialPresenceUpdatedAt,
    },
  });
  return { localUserId, remoteUserId, initialPresenceUpdatedAt };
}

/**
 * Make a local-on-B user with a username. No JWT needed — every flow in this
 * file is driven through the unauthenticated `/_federation/event` endpoint —
 * but we need an owner for the federated Tavern (step 2) and a co-member to
 * make the shared-surface invariant a real one rather than a setup quirk.
 */
async function makeLocalUser(prefix: string): Promise<{ id: string; username: string }> {
  const id = ulid();
  const username = `${prefix}-${id.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@example.com`,
      emailLower: `${username}@example.com`,
      passwordHash: 'x',
    },
  });
  return { id, username };
}

/**
 * Create the shared federated Tavern T. Both alice (mirror) and bob (local)
 * are added as `ServerMember` rows so the share-server invariant holds in
 * principle (the presence handler itself doesn't consult it — it operates on
 * the User row's mirror state — but the test mirrors the production scenario
 * where the share is the reason fan-out happens at all).
 */
async function seedSharedFederatedServer(opts: {
  ownerId: string;
  memberIds: string[];
}): Promise<string> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: opts.ownerId,
      name: 'Phase 6 Tavern',
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
 * Build a single-layer signed `presence.update` envelope as `peer` would emit
 * it. Single-layer (instance-only) per Phase 6 decision #6 — presence is not
 * a user-authored content event.
 */
function buildPresenceEnvelope(input: {
  peer: PeerSeed;
  userRemoteUserId: string;
  presence: 'active' | 'idle' | 'dnd' | 'offline';
  customStatus?: string | null;
  customStatusExpiresAt?: string | null;
  updatedAt: Date;
}): ReturnType<typeof buildSignedEnvelope<unknown>> {
  return buildSignedEnvelope({
    eventType: 'presence.update',
    fromInstance: input.peer.host,
    toInstance: B_HOST,
    payload: {
      userRemoteUserId: input.userRemoteUserId,
      presence: input.presence,
      customStatus:
        input.customStatus === undefined ? null : input.customStatus,
      customStatusExpiresAt:
        input.customStatusExpiresAt === undefined
          ? null
          : input.customStatusExpiresAt,
      updatedAt: input.updatedAt.toISOString(),
    },
    sign: (bytes) => edSign(bytes, input.peer.peerKp.privateKey),
  });
}

/**
 * Wipe the DB between tests. Order matters because of FK cascades.
 */
async function reset(): Promise<void> {
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.messageEdit.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
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
}

describe.skipIf(!dockerOk)('Federation Phase 6 — end-to-end smoke', () => {
  beforeEach(async () => {
    await reset();
  });

  it(
    'happy path: idle → custom status → offline → clear, plus authority + watermark + capability gates',
    async () => {
      // ─── Step 1 (Sim): A and B are peered with `presence` capability ─────────
      const peerA = await seedPeer(A_HOST, ['messages', 'presence']);

      // ─── Step 2 (Sim): alice on A + bob on B share federated Tavern T ───────
      // alice's qualified id is `alice@a.example`. Her local mirror User row
      // is created with an initial baseline so the watermark check (step 12)
      // has something to compare against.
      const baseline = new Date('2026-04-01T08:00:00.000Z');
      const aliceMirror = await seedMirrorUser({
        peer: peerA,
        localpart: 'alice',
        initialPresence: 'active',
        initialPresenceUpdatedAt: baseline,
      });
      const bob = await makeLocalUser('bob');
      await seedSharedFederatedServer({
        ownerId: bob.id,
        memberIds: [bob.id, aliceMirror.localUserId],
      });

      // ─── Boot B with FEDERATION_ENABLED + FEDERATION_PRESENCE_ENABLED (default) ─
      const app = await buildApp({
        config: loadConfig(envFor({ dbUrl: ctx!.databaseUrl })),
      });

      // Gateway broker observer — used to confirm PRESENCE_UPDATE fires
      // post-commit for each accepted envelope.
      const events: Array<{
        type: string;
        userId?: string;
        data: unknown;
      }> = [];
      const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

      try {
        // ─── Step 3-4 (REAL): alice → idle on her home; B's mirror updated ───
        // A signs an envelope advancing alice's presence past the baseline.
        const idleAt = new Date(baseline.getTime() + 60_000);
        const idleEnv = buildPresenceEnvelope({
          peer: peerA,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'idle',
          updatedAt: idleAt,
        });

        const eventsBeforeIdle = events.length;
        const idleRes = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: idleEnv,
        });
        expect(idleRes.statusCode).toBe(200);
        const idleBody = idleRes.json();
        expect(idleBody.ok).toBe(true);
        expect(idleBody.data?.userId).toBe(aliceMirror.localUserId);

        const aliceAfterIdle = await prisma.user.findUniqueOrThrow({
          where: { id: aliceMirror.localUserId },
          select: {
            presence: true,
            presenceUpdatedAt: true,
            customStatus: true,
            customStatusExpiresAt: true,
          },
        });
        expect(aliceAfterIdle.presence).toBe('idle');
        expect(aliceAfterIdle.presenceUpdatedAt.toISOString()).toBe(
          idleAt.toISOString(),
        );
        expect(aliceAfterIdle.customStatus).toBeNull();
        expect(aliceAfterIdle.customStatusExpiresAt).toBeNull();

        // PRESENCE_UPDATE addressed to the mirror's local id fired.
        const idleBroadcasts = events
          .slice(eventsBeforeIdle)
          .filter((e) => e.type === 'PRESENCE_UPDATE');
        expect(idleBroadcasts.length).toBeGreaterThanOrEqual(1);
        expect(
          idleBroadcasts.find(
            (e) =>
              (e.data as { userId?: string; presence?: string }).userId ===
                aliceMirror.localUserId &&
              (e.data as { presence?: string }).presence === 'idle',
          ),
        ).toBeTruthy();

        // ─── Step 5-6 (REAL): alice sets custom status with +1h expiry ───────
        // Envelope carries presence=idle (unchanged) PLUS the custom status
        // fields. Receiver applies the full snapshot atomically.
        const statusAt = new Date(idleAt.getTime() + 60_000);
        const statusExpiresAt = new Date(statusAt.getTime() + 3_600_000); // +1h
        const statusEnv = buildPresenceEnvelope({
          peer: peerA,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'idle',
          customStatus: 'In a session',
          customStatusExpiresAt: statusExpiresAt.toISOString(),
          updatedAt: statusAt,
        });

        const statusRes = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: statusEnv,
        });
        expect(statusRes.statusCode).toBe(200);

        const aliceAfterStatus = await prisma.user.findUniqueOrThrow({
          where: { id: aliceMirror.localUserId },
          select: {
            presence: true,
            customStatus: true,
            customStatusExpiresAt: true,
          },
        });
        expect(aliceAfterStatus.presence).toBe('idle');
        expect(aliceAfterStatus.customStatus).toBe('In a session');
        expect(aliceAfterStatus.customStatusExpiresAt?.toISOString()).toBe(
          statusExpiresAt.toISOString(),
        );

        // ─── Step 7-8 (REAL): alice's last socket closes; → offline ─────────
        // On A this would come from `markDisconnected` via the immediate-
        // fan-out path. The custom status survives the presence transition
        // because the envelope carries the FULL state (presence + status are
        // independent — Phase 6 decision #1).
        const offlineAt = new Date(statusAt.getTime() + 60_000);
        const offlineEnv = buildPresenceEnvelope({
          peer: peerA,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'offline',
          customStatus: 'In a session',
          customStatusExpiresAt: statusExpiresAt.toISOString(),
          updatedAt: offlineAt,
        });

        const eventsBeforeOffline = events.length;
        const offlineRes = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: offlineEnv,
        });
        expect(offlineRes.statusCode).toBe(200);

        const aliceAfterOffline = await prisma.user.findUniqueOrThrow({
          where: { id: aliceMirror.localUserId },
          select: { presence: true, customStatus: true },
        });
        expect(aliceAfterOffline.presence).toBe('offline');
        expect(aliceAfterOffline.customStatus).toBe('In a session');

        const offlineBroadcasts = events
          .slice(eventsBeforeOffline)
          .filter(
            (e) =>
              e.type === 'PRESENCE_UPDATE' &&
              (e.data as { userId?: string }).userId === aliceMirror.localUserId &&
              (e.data as { presence?: string }).presence === 'offline',
          );
        expect(offlineBroadcasts.length).toBeGreaterThanOrEqual(1);

        // ─── Step 9-10 (REAL): alice clears her custom status ───────────────
        const clearAt = new Date(offlineAt.getTime() + 60_000);
        const clearEnv = buildPresenceEnvelope({
          peer: peerA,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'offline',
          customStatus: null,
          customStatusExpiresAt: null,
          updatedAt: clearAt,
        });
        const clearRes = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: clearEnv,
        });
        expect(clearRes.statusCode).toBe(200);

        const aliceAfterClear = await prisma.user.findUniqueOrThrow({
          where: { id: aliceMirror.localUserId },
          select: {
            presence: true,
            customStatus: true,
            customStatusExpiresAt: true,
          },
        });
        expect(aliceAfterClear.presence).toBe('offline');
        expect(aliceAfterClear.customStatus).toBeNull();
        expect(aliceAfterClear.customStatusExpiresAt).toBeNull();

        // Four envelope log rows landed (idle, status set, offline, clear),
        // all keyed on peer A. Replay protection is exercised in
        // federation-inbound.test.ts; here we just confirm the log path runs.
        const logs = await prisma.federationEnvelopeLog.findMany({
          where: {
            peerInstanceId: peerA.peerId,
            eventType: 'presence.update',
          },
          select: { status: true, direction: true },
        });
        expect(logs).toHaveLength(4);
        expect(logs.every((l) => l.status === 'accepted')).toBe(true);
        expect(logs.every((l) => l.direction === 'inbound')).toBe(true);

        // ─── Step 11 (REAL): authority check — peer C cannot assert alice ────
        // C is peered but is not alice's home. The handler must reject before
        // persisting; the watermark from the legitimate clear envelope (step
        // 10) MUST survive untouched.
        const peerC = await seedPeer(C_HOST, ['messages', 'presence']);
        const spoofEnv = buildPresenceEnvelope({
          peer: peerC,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'active',
          updatedAt: new Date(clearAt.getTime() + 60_000),
        });
        const spoofRes = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: spoofEnv,
        });
        expect(spoofRes.statusCode).toBe(403);
        const spoofBody = spoofRes.json();
        expect(spoofBody.error).toMatch(/cannot emit presence|not_home/i);

        const aliceAfterSpoof = await prisma.user.findUniqueOrThrow({
          where: { id: aliceMirror.localUserId },
          select: { presence: true, presenceUpdatedAt: true },
        });
        expect(aliceAfterSpoof.presence).toBe('offline'); // unchanged
        expect(aliceAfterSpoof.presenceUpdatedAt.toISOString()).toBe(
          clearAt.toISOString(),
        );

        // ─── Step 12 (REAL): watermark check — stale replay ─────────────────
        // A re-sends an envelope with an updatedAt EQUAL TO baseline (well
        // before the current clearAt watermark). Spec says `<=` is stale, so
        // even an equal timestamp must be skipped.
        const staleEnv = buildPresenceEnvelope({
          peer: peerA,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'active',
          updatedAt: baseline, // earlier than the current presenceUpdatedAt
        });
        const staleRes = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: staleEnv,
        });
        expect(staleRes.statusCode).toBe(200);
        const staleBody = staleRes.json();
        expect(staleBody.data?.skipped).toBe('stale');

        const aliceAfterStale = await prisma.user.findUniqueOrThrow({
          where: { id: aliceMirror.localUserId },
          select: { presence: true, presenceUpdatedAt: true },
        });
        // Presence must NOT have moved off offline.
        expect(aliceAfterStale.presence).toBe('offline');
        expect(aliceAfterStale.presenceUpdatedAt.toISOString()).toBe(
          clearAt.toISOString(),
        );

        // Outbound payload shape — defensive structural assertion that every
        // envelope we sent through this test would round-trip the wire
        // schema A produces in production.
        for (const env of [idleEnv, statusEnv, offlineEnv, clearEnv, staleEnv]) {
          expect(() =>
            federatedPresenceUpdatePayloadSchema.parse(env.payload),
          ).not.toThrow();
        }
      } finally {
        unsubscribe();
        await app.close();
      }

      // ─── Step 13 (REAL): capability gate — FEDERATION_PRESENCE_ENABLED=false ─
      // Rebuild the app with the env flag off. Construct a fresh, validly-
      // signed envelope from A; the dispatcher must reject it BEFORE
      // signature work with 403 `presence_capability_missing`, and no
      // envelope log row should be inserted.
      const appOff = await buildApp({
        config: loadConfig(
          envFor({ dbUrl: ctx!.databaseUrl, presenceEnabled: false }),
        ),
      });
      try {
        const gatedEnv = buildPresenceEnvelope({
          peer: peerA,
          userRemoteUserId: aliceMirror.remoteUserId,
          presence: 'active',
          updatedAt: new Date(),
        });

        // Snapshot the current count so we can confirm the dispatcher did
        // NOT add a new row.
        const logsBeforeGate = await prisma.federationEnvelopeLog.count({
          where: { peerInstanceId: peerA.peerId, eventType: 'presence.update' },
        });

        const gatedRes = await appOff.inject({
          method: 'POST',
          url: '/_federation/event',
          headers: { 'content-type': 'application/json' },
          payload: gatedEnv,
        });
        expect(gatedRes.statusCode).toBe(403);
        const gatedBody = gatedRes.json();
        expect(gatedBody.error).toMatch(/presence/i);

        const logsAfterGate = await prisma.federationEnvelopeLog.count({
          where: { peerInstanceId: peerA.peerId, eventType: 'presence.update' },
        });
        expect(logsAfterGate).toBe(logsBeforeGate); // gate ran before the log write
      } finally {
        await appOff.close();
      }
    },
    60_000,
  );
});
