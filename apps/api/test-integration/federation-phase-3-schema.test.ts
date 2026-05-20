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

describe.skipIf(!dockerOk)('federation phase 3 schema', () => {
  it('User accepts null passwordHash and stores remoteUserId/remoteInstanceId', async () => {
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: { id: peerId, host: `peer-${peerId}.example`, instanceKey: Buffer.alloc(32, 1), status: 'peered', capabilities: ['messages'] },
    });
    const uid = ulid();
    await prisma.user.create({
      data: {
        id: uid,
        username: `__rem_${uid.toLowerCase()}`,
        usernameLower: `__rem_${uid.toLowerCase()}`,
        displayName: 'Alice',
        email: `${uid.toLowerCase()}@remote.test`,
        emailLower: `${uid.toLowerCase()}@remote.test`,
        passwordHash: null,
        remoteUserId: `alice-${uid.toLowerCase()}@peer-${peerId}.example`,
        remoteInstanceId: peerId,
      },
    });
    const u = await prisma.user.findUnique({ where: { id: uid } });
    expect(u?.passwordHash).toBeNull();
    expect(u?.remoteUserId).toContain('@');
  });

  it('Server.federationEnabled defaults to false and is settable', async () => {
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `owner-${ownerId.toLowerCase()}`,
        usernameLower: `owner-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const sid = ulid();
    await prisma.server.create({
      data: { id: sid, name: 'T', ownerUserId: ownerId },
    });
    let s = await prisma.server.findUnique({ where: { id: sid } });
    expect(s?.federationEnabled).toBe(false);
    await prisma.server.update({ where: { id: sid }, data: { federationEnabled: true } });
    s = await prisma.server.findUnique({ where: { id: sid } });
    expect(s?.federationEnabled).toBe(true);
  });

  it('Channel.federationMode defaults to inherit and accepts force_on / force_off', async () => {
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `owner2-${ownerId.toLowerCase()}`,
        usernameLower: `owner2-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const sid = ulid();
    await prisma.server.create({ data: { id: sid, name: 'T', ownerUserId: ownerId } });
    const cid = ulid();
    await prisma.channel.create({ data: { id: cid, serverId: sid, name: 'gen', type: 'text' } });
    let c = await prisma.channel.findUnique({ where: { id: cid } });
    expect(c?.federationMode).toBe('inherit');
    await prisma.channel.update({ where: { id: cid }, data: { federationMode: 'force_on' } });
    c = await prisma.channel.findUnique({ where: { id: cid } });
    expect(c?.federationMode).toBe('force_on');
  });

  it('Message accepts signature + originInstanceId', async () => {
    // Setup: owner, server, channel, remote instance, remote user as User row
    const ownerId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: `owner3-${ownerId.toLowerCase()}`,
        usernameLower: `owner3-${ownerId.toLowerCase()}`,
        displayName: 'Owner',
        email: `${ownerId.toLowerCase()}@example.test`,
        emailLower: `${ownerId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    const sid = ulid();
    await prisma.server.create({ data: { id: sid, name: 'T', ownerUserId: ownerId } });
    const cid = ulid();
    await prisma.channel.create({ data: { id: cid, serverId: sid, name: 'gen', type: 'text' } });
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: { id: peerId, host: `peer-${peerId}.example`, instanceKey: Buffer.alloc(32, 1), status: 'peered', capabilities: ['messages'] },
    });
    const remoteUid = ulid();
    await prisma.user.create({
      data: {
        id: remoteUid,
        username: `__rem_${remoteUid.toLowerCase()}`,
        usernameLower: `__rem_${remoteUid.toLowerCase()}`,
        displayName: 'Alice',
        email: `${remoteUid.toLowerCase()}@remote.test`,
        emailLower: `${remoteUid.toLowerCase()}@remote.test`,
        passwordHash: null,
        remoteUserId: `alice-${remoteUid.toLowerCase()}@peer-${peerId}.example`,
        remoteInstanceId: peerId,
      },
    });
    const mid = ulid();
    await prisma.message.create({
      data: {
        id: mid,
        serverId: sid,
        channelId: cid,
        authorId: remoteUid,
        content: 'hello from B',
        signature: Buffer.alloc(64, 9),
        originInstanceId: peerId,
      },
    });
    const m = await prisma.message.findUnique({ where: { id: mid } });
    expect(m?.signature?.length).toBe(64);
    expect(m?.originInstanceId).toBe(peerId);
  });
});
