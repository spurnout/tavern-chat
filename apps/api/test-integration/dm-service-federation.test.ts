/**
 * P5-2 — federation-aware DM pair-key + share-server check.
 *
 * Coverage matrix:
 *   1. Federated DM pairKey uses qualified-id form (`alice@a:bob@b`).
 *   2. Local DM pairKey uses local-id form (sorted `userIdA:userIdB`).
 *   3. Concurrent `findOrCreateDirectDm` for the same pair → exactly one
 *      DmChannel row (UNIQUE pairKey wins the race).
 *   4. `usersShareServer` returns true when one side is a federated mirror
 *      User row (`remoteUserId IS NOT NULL`) that is a member of a server
 *      the other user is also a member of — i.e. confirms the existing
 *      query works as-is for federation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, serializePermissions, ulid } from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import {
  directPairKey,
  federatedDmPairKey,
  findOrCreateDirectDm,
  usersShareServer,
} from '../src/services/dm-service.js';

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

const SELF_HOST = 'a.example';

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

async function seedPeer(host: string): Promise<{ id: string; host: string }> {
  const id = ulid();
  await prisma.remoteInstance.create({
    data: {
      id,
      host,
      instanceKey: randomBytes(32),
      status: 'peered',
      capabilities: ['messages'],
      peeredAt: new Date(),
    },
  });
  return { id, host };
}

/**
 * Seed a remote-user mirror: RemoteUser cache row + local User row with
 * `remoteUserId` set. Mirrors are how Tavern represents a remote user
 * locally — see federation-mirror.ts.
 */
async function createRemoteUserMirror(
  peer: { id: string; host: string },
  localpart: string,
): Promise<{ localUserId: string; remoteUserId: string; localUsername: string }> {
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
  return { localUserId, remoteUserId: qualified, localUsername: syntheticUsername };
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

async function cleanDb(): Promise<void> {
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMemberRole.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
}

describe.skipIf(!dockerOk)('P5-2 — federation-aware DM service', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  // ─── 1. Federated DM uses qualified-id pairKey ──────────────────────────

  it('federated DM pairKey uses qualified-id form', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');

    const dmId = await findOrCreateDirectDm(alice.id, bobMirror.localUserId, {
      selfHost: SELF_HOST,
    });

    const row = await prisma.dmChannel.findUniqueOrThrow({
      where: { id: dmId },
      select: { pairKey: true, kind: true, members: { select: { userId: true } } },
    });

    const aliceQualified = `${alice.username}@${SELF_HOST}`;
    const expected = federatedDmPairKey(aliceQualified, bobMirror.remoteUserId);
    expect(row.pairKey).toBe(expected);
    expect(row.kind).toBe('direct');
    // Sanity: both ends are stored as DmChannelMember rows with their local
    // User ids — only the pairKey switches to qualified form.
    const memberIds = row.members.map((m) => m.userId).sort();
    expect(memberIds).toEqual([alice.id, bobMirror.localUserId].sort());
  });

  // ─── 2. Local DM keeps the local-id pairKey ─────────────────────────────

  it('local DM pairKey uses local-id form', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');

    const dmId = await findOrCreateDirectDm(alice.id, dave.id, { selfHost: SELF_HOST });

    const row = await prisma.dmChannel.findUniqueOrThrow({
      where: { id: dmId },
      select: { pairKey: true },
    });
    expect(row.pairKey).toBe(directPairKey(alice.id, dave.id));
  });

  // ─── 3. Concurrent same-pair → exactly one row ──────────────────────────

  it('concurrent findOrCreateDirectDm calls produce exactly one DmChannel row', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');

    // Race two calls for the same pair. The UNIQUE constraint on pairKey
    // serialises them; one wins, the other recovers via P2002 → re-fetch.
    const [a, b] = await Promise.all([
      findOrCreateDirectDm(alice.id, bobMirror.localUserId, { selfHost: SELF_HOST }),
      findOrCreateDirectDm(alice.id, bobMirror.localUserId, { selfHost: SELF_HOST }),
    ]);
    expect(a).toBe(b);

    const aliceQualified = `${alice.username}@${SELF_HOST}`;
    const pairKey = federatedDmPairKey(aliceQualified, bobMirror.remoteUserId);
    const count = await prisma.dmChannel.count({ where: { pairKey } });
    expect(count).toBe(1);
  });

  // ─── 4. usersShareServer works for federated mirror members ─────────────

  it('usersShareServer returns true when bob is a federated mirror member of a shared server', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');

    // Alice owns a federated server; bob's mirror joined as a remote member.
    await createServerWithMembers(alice.id, [bobMirror.localUserId], {
      federationEnabled: true,
    });

    const shares = await usersShareServer(alice.id, bobMirror.localUserId);
    expect(shares).toBe(true);

    // Sanity counter-check: a third user with no shared server returns false.
    const carol = await createLocalUser('carol');
    const sharesWithCarol = await usersShareServer(alice.id, carol.id);
    expect(sharesWithCarol).toBe(false);
  });

  // ─── Bonus: local DM still works when selfHost is provided but the other
  //     side has no remoteUserId (i.e. both local). The gate hinges on
  //     `remoteUserId !== null`, not on selfHost. ────────────────────────

  it('local DM uses local-id pairKey even when selfHost is provided', async () => {
    const alice = await createLocalUser('alice');
    const dave = await createLocalUser('dave');

    const dmId = await findOrCreateDirectDm(alice.id, dave.id, { selfHost: SELF_HOST });
    const row = await prisma.dmChannel.findUniqueOrThrow({
      where: { id: dmId },
      select: { pairKey: true },
    });
    expect(row.pairKey).toBe(directPairKey(alice.id, dave.id));
    // And not the qualified form.
    expect(row.pairKey).not.toContain('@');
  });
});
