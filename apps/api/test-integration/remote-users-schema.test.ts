/**
 * Integration smoke test for the federation Phase 2 schema
 * (RemoteUser table + User.federationKeyPublic/Private columns).
 * Verifies the new table accepts writes, cascade-delete works, and the
 * nullable key columns on User round-trip correctly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';

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

describe.skipIf(!dockerOk)('remote-users + user federation keys schema (phase 2)', () => {
  it('persists a RemoteUser row tied to a RemoteInstance', async () => {
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: `peer-${peerId}.example`,
        instanceKey: Buffer.alloc(32, 3),
        status: 'peered',
        capabilities: ['messages'],
      },
    });
    const userId = ulid();
    await prisma.remoteUser.create({
      data: {
        id: userId,
        remoteInstanceId: peerId,
        remoteUserId: `alice-${userId}@peer-${peerId}.example`,
        displayNameCache: 'Alice',
        avatarUrlCache: null,
        publicKey: Buffer.alloc(32, 7),
      },
    });
    const found = await prisma.remoteUser.findUnique({ where: { id: userId } });
    expect(found?.displayNameCache).toBe('Alice');
  });

  it('cascades delete when RemoteInstance is removed', async () => {
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: `peer-${peerId}.example`,
        instanceKey: Buffer.alloc(32, 3),
        status: 'peered',
        capabilities: [],
      },
    });
    const remoteUserId = ulid();
    await prisma.remoteUser.create({
      data: {
        id: remoteUserId,
        remoteInstanceId: peerId,
        remoteUserId: `alice-${remoteUserId}@peer-${peerId}.example`,
        displayNameCache: 'Alice',
        publicKey: Buffer.alloc(32, 9),
      },
    });
    await prisma.remoteInstance.delete({ where: { id: peerId } });
    const orphan = await prisma.remoteUser.findUnique({ where: { id: remoteUserId } });
    expect(orphan).toBeNull();
  });

  it('User accepts nullable federationKeyPublic/Private', async () => {
    const uid = ulid();
    await prisma.user.create({
      data: {
        id: uid,
        username: `tester${uid.toLowerCase()}`,
        usernameLower: `tester${uid.toLowerCase()}`,
        displayName: 'Tester',
        email: `${uid.toLowerCase()}@example.test`,
        emailLower: `${uid.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
        federationKeyPublic: Buffer.alloc(32, 5),
        federationKeyPrivate: Buffer.from('encrypted-blob'),
      },
    });
    const u = await prisma.user.findUnique({ where: { id: uid } });
    expect(u?.federationKeyPublic?.length).toBe(32);
    expect(u?.federationKeyPrivate?.toString()).toBe('encrypted-blob');
  });
});
