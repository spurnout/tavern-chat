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

describe.skipIf(!dockerOk)('federation phase 4 schema', () => {
  it('Invite accepts the three federated-invite fields together and individually', async () => {
    // Setup: owner + server so the Invite has a valid serverId FK.
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `inviteowner-${ownerId.toLowerCase()}`,
        usernameLower: `inviteowner-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const sid = ulid();
    await prisma.server.create({ data: { id: sid, name: 'T', ownerUserId: ownerId } });

    // Local-only invite — all three new fields null.
    const localId = ulid();
    await prisma.invite.create({
      data: {
        id: localId,
        code: `local-${localId.toLowerCase()}`,
        scope: 'server',
        serverId: sid,
      },
    });
    const local = await prisma.invite.findUnique({ where: { id: localId } });
    expect(local?.remoteScope).toBeNull();
    expect(local?.remoteInstanceHost).toBeNull();
    expect(local?.remoteUserId).toBeNull();

    // any_peer — no host / user pinning.
    const anyId = ulid();
    await prisma.invite.create({
      data: {
        id: anyId,
        code: `any-${anyId.toLowerCase()}`,
        scope: 'server',
        serverId: sid,
        remoteScope: 'any_peer',
      },
    });
    let inv = await prisma.invite.findUnique({ where: { id: anyId } });
    expect(inv?.remoteScope).toBe('any_peer');

    // specific_instance — host pinned, no user.
    const instId = ulid();
    await prisma.invite.create({
      data: {
        id: instId,
        code: `inst-${instId.toLowerCase()}`,
        scope: 'server',
        serverId: sid,
        remoteScope: 'specific_instance',
        remoteInstanceHost: 'b.example',
      },
    });
    inv = await prisma.invite.findUnique({ where: { id: instId } });
    expect(inv?.remoteScope).toBe('specific_instance');
    expect(inv?.remoteInstanceHost).toBe('b.example');

    // specific_user — host + user pinned to a qualified identity.
    const userInvId = ulid();
    await prisma.invite.create({
      data: {
        id: userInvId,
        code: `user-${userInvId.toLowerCase()}`,
        scope: 'server',
        serverId: sid,
        remoteScope: 'specific_user',
        remoteInstanceHost: 'b.example',
        remoteUserId: 'alice@b.example',
      },
    });
    inv = await prisma.invite.findUnique({ where: { id: userInvId } });
    expect(inv?.remoteScope).toBe('specific_user');
    expect(inv?.remoteInstanceHost).toBe('b.example');
    expect(inv?.remoteUserId).toBe('alice@b.example');

    // Update path — clearing the federated fields works.
    await prisma.invite.update({
      where: { id: userInvId },
      data: { remoteScope: null, remoteInstanceHost: null, remoteUserId: null },
    });
    inv = await prisma.invite.findUnique({ where: { id: userInvId } });
    expect(inv?.remoteScope).toBeNull();
    expect(inv?.remoteInstanceHost).toBeNull();
    expect(inv?.remoteUserId).toBeNull();
  });

  it('Server.originInstanceId defaults to null and accepts a peered instance id', async () => {
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `mirrorowner-${ownerId.toLowerCase()}`,
        usernameLower: `mirrorowner-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });

    // Local Server first — origin null.
    const localSid = ulid();
    await prisma.server.create({ data: { id: localSid, name: 'Local', ownerUserId: ownerId } });
    const sLocal = await prisma.server.findUnique({ where: { id: localSid } });
    expect(sLocal?.originInstanceId).toBeNull();

    // Peered RemoteInstance.
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: `peer-${peerId}.example`,
        instanceKey: Buffer.alloc(32, 2),
        status: 'peered',
        capabilities: ['messages', 'mirror'],
      },
    });

    // Mirror Server — origin set to the peer.
    const mirrorSid = ulid();
    await prisma.server.create({
      data: {
        id: mirrorSid,
        name: 'Mirror',
        ownerUserId: ownerId,
        originInstanceId: peerId,
      },
    });
    const sMirror = await prisma.server.findUnique({
      where: { id: mirrorSid },
      include: { originInstance: true },
    });
    expect(sMirror?.originInstanceId).toBe(peerId);
    expect(sMirror?.originInstance?.host).toBe(`peer-${peerId}.example`);

    // Back-ref: RemoteInstance.mirroredServers includes the new row.
    const peer = await prisma.remoteInstance.findUnique({
      where: { id: peerId },
      include: { mirroredServers: true },
    });
    expect(peer?.mirroredServers.some((row) => row.id === mirrorSid)).toBe(true);
  });

  it('Channel.originInstanceId defaults to null and accepts a peered instance id', async () => {
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `chanowner-${ownerId.toLowerCase()}`,
        usernameLower: `chanowner-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const sid = ulid();
    await prisma.server.create({ data: { id: sid, name: 'T', ownerUserId: ownerId } });

    // Local channel — origin null.
    const localCid = ulid();
    await prisma.channel.create({
      data: { id: localCid, serverId: sid, name: 'general', type: 'text' },
    });
    const cLocal = await prisma.channel.findUnique({ where: { id: localCid } });
    expect(cLocal?.originInstanceId).toBeNull();

    // Peered RemoteInstance + mirror channel.
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: `peer-${peerId}.example`,
        instanceKey: Buffer.alloc(32, 3),
        status: 'peered',
        capabilities: ['messages', 'mirror'],
      },
    });
    const mirrorCid = ulid();
    await prisma.channel.create({
      data: {
        id: mirrorCid,
        serverId: sid,
        name: 'mirror-channel',
        type: 'text',
        originInstanceId: peerId,
      },
    });
    const cMirror = await prisma.channel.findUnique({
      where: { id: mirrorCid },
      include: { originInstance: true },
    });
    expect(cMirror?.originInstanceId).toBe(peerId);
    expect(cMirror?.originInstance?.host).toBe(`peer-${peerId}.example`);

    // Back-ref via RemoteInstance.mirroredChannels.
    const peer = await prisma.remoteInstance.findUnique({
      where: { id: peerId },
      include: { mirroredChannels: true },
    });
    expect(peer?.mirroredChannels.some((row) => row.id === mirrorCid)).toBe(true);
  });

  it('Deleting the origin RemoteInstance sets Server.originInstanceId / Channel.originInstanceId to null (no cascade)', async () => {
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `cascadeowner-${ownerId.toLowerCase()}`,
        usernameLower: `cascadeowner-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: `peer-${peerId}.example`,
        instanceKey: Buffer.alloc(32, 4),
        status: 'peered',
        capabilities: ['messages'],
      },
    });
    const sid = ulid();
    await prisma.server.create({
      data: { id: sid, name: 'Mirror', ownerUserId: ownerId, originInstanceId: peerId },
    });
    const cid = ulid();
    await prisma.channel.create({
      data: { id: cid, serverId: sid, name: 'c', type: 'text', originInstanceId: peerId },
    });

    // Sanity — mirror rows reference the peer.
    expect((await prisma.server.findUnique({ where: { id: sid } }))?.originInstanceId).toBe(peerId);
    expect((await prisma.channel.findUnique({ where: { id: cid } }))?.originInstanceId).toBe(peerId);

    // Drop the peer. Mirror rows must survive (SetNull on the FK) so messages
    // and channel state aren't taken down with the peer record.
    await prisma.remoteInstance.delete({ where: { id: peerId } });

    const s = await prisma.server.findUnique({ where: { id: sid } });
    const c = await prisma.channel.findUnique({ where: { id: cid } });
    expect(s).not.toBeNull();
    expect(s?.originInstanceId).toBeNull();
    expect(c).not.toBeNull();
    expect(c?.originInstanceId).toBeNull();
  });

  it('Foreign-key enforcement: a non-existent originInstanceId is rejected', async () => {
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `fkowner-${ownerId.toLowerCase()}`,
        usernameLower: `fkowner-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const sid = ulid();
    await expect(
      prisma.server.create({
        data: {
          id: sid,
          name: 'Bad',
          ownerUserId: ownerId,
          originInstanceId: ulid(), // not a real RemoteInstance
        },
      }),
    ).rejects.toThrow();
  });
});
