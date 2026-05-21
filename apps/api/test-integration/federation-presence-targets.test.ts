/**
 * P6-5 — `findPresenceFanOutPeers` helper test.
 *
 * Verifies the peer scoping query: given a LOCAL user, return the set of
 * peered RemoteInstances that share at least one federated Tavern or
 * federated DM with that user. The helper is used by the P6-6 outbound
 * presence fan-out path to decide which peers receive a `presence.update`
 * envelope.
 *
 * Coverage (from the Phase 6 plan):
 *   1. Shares ONE federated Tavern with one peer → 1 result.
 *   2. Shares ONE federated DM with one peer → 1 result.
 *   3. Shares BOTH with the same peer → 1 result (dedupe by peerInstanceId).
 *   4. Shares a federated Tavern with peer X AND a federated DM with peer Y
 *      → 2 results, both peers present.
 *   5. Shares no federated surface with any peer → 0 results.
 *   6. Membership in a `federationEnabled = false` Tavern alongside a peer
 *      → 0 results (the server flag suppresses the peer).
 *   7. Peer with `status = 'revoked'` → not included even when a shared
 *      federated surface exists.
 *
 * NOTE: This suite requires Docker (testcontainers Postgres). Same posture
 * as the rest of the Phase 3–5 integration suites — when Docker is
 * unavailable the suite is skipped, not failed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { findPresenceFanOutPeers } from '../src/services/federation-presence-targets.js';

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
  status: 'peered' | 'revoked' | 'pending_inbound' | 'pending_outbound' | 'blocked' = 'peered',
  capabilities: string[] = ['messages', 'dms', 'presence'],
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
): Promise<{ localUserId: string }> {
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
  return { localUserId };
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
  // The helper doesn't read role rows — only ServerMember + Server. Skip the
  // everyone-role + permissions plumbing; we just need membership edges to
  // exist.
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
      members: {
        create: [{ userId: userAId }, { userId: userBId }],
      },
    },
  });
  return channelId;
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

describe.skipIf(!dockerOk)('findPresenceFanOutPeers (P6-5)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('returns 1 peer when the user shares one federated Tavern with one peer', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], { federationEnabled: true });

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toEqual({ peerInstanceId: peerB.id, host: 'b.example' });
  });

  it('returns 1 peer when the user shares one federated DM with one peer', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createDirectDmChannel(alice.id, bobMirror.localUserId);

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toEqual({ peerInstanceId: peerB.id, host: 'b.example' });
  });

  it('dedupes to 1 result when the user shares BOTH a federated Tavern and DM with the same peer', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], { federationEnabled: true });
    await createDirectDmChannel(alice.id, bobMirror.localUserId);

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerInstanceId).toBe(peerB.id);
  });

  it('returns 2 peers when sharing a federated Tavern with peer X AND a federated DM with peer Y', async () => {
    const alice = await createLocalUser('alice');
    const peerX = await seedPeer('x.example');
    const peerY = await seedPeer('y.example');
    const bobMirror = await createRemoteUserMirror(peerX, 'bob');
    const carolMirror = await createRemoteUserMirror(peerY, 'carol');
    await createServerWithMembers(alice.id, [bobMirror.localUserId], { federationEnabled: true });
    await createDirectDmChannel(alice.id, carolMirror.localUserId);

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(2);
    const ids = new Set(peers.map((p) => p.peerInstanceId));
    expect(ids.has(peerX.id)).toBe(true);
    expect(ids.has(peerY.id)).toBe(true);
  });

  it('returns 0 peers when the user shares no federated surface with any peer', async () => {
    const alice = await createLocalUser('alice');
    // A peer exists but alice is not connected to it in any way.
    const peerB = await seedPeer('b.example');
    await createRemoteUserMirror(peerB, 'bob');

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(0);
  });

  it('does NOT surface a peer through a Tavern with federationEnabled=false', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    // Co-membership exists, but the server flag is off — fan-out should not
    // include this peer for this surface.
    await createServerWithMembers(alice.id, [bobMirror.localUserId], { federationEnabled: false });

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(0);
  });

  it('does NOT include a revoked peer even when a federated surface is shared', async () => {
    const alice = await createLocalUser('alice');
    const peerB = await seedPeer('b.example', 'revoked');
    const bobMirror = await createRemoteUserMirror(peerB, 'bob');
    // Both surfaces present — but the peer's status disqualifies it.
    await createServerWithMembers(alice.id, [bobMirror.localUserId], { federationEnabled: true });
    await createDirectDmChannel(alice.id, bobMirror.localUserId);

    const peers = await findPresenceFanOutPeers(prisma, alice.id);
    expect(peers).toHaveLength(0);
  });
});
