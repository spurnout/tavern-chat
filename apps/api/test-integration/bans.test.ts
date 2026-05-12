/**
 * Integration tests for PERM-002 (BAN_MEMBERS): banMember / unbanMember /
 * isBanned / activeBanServerIds. Hit the real Postgres so we exercise the
 * Prisma migration that introduced the ServerBan model plus its cascade
 * relations.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
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

async function makeServerWithOwner(): Promise<{
  ownerId: string;
  memberId: string;
  serverId: string;
}> {
  const ownerId = ulid();
  const memberId = ulid();
  const serverId = ulid();
  const everyoneId = ulid();
  for (const [id, name] of [
    [ownerId, `owner-${ownerId.slice(-6)}`],
    [memberId, `member-${memberId.slice(-6)}`],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: name,
        usernameLower: name,
        displayName: name,
        email: `${name}@example.com`,
        emailLower: `${name}@example.com`,
        passwordHash: 'x',
      },
    });
  }
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'B' } });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: memberId } });
  return { ownerId, memberId, serverId };
}

describe.skipIf(!dockerOk)('ban-service (PERM-002)', () => {
  it('bans a member, removes them from the server, and blocks future joins', async () => {
    const { ownerId, memberId, serverId } = await makeServerWithOwner();
    const { banMember, isBanned } = await import('../src/services/ban-service.js');

    await banMember({
      serverId,
      targetUserId: memberId,
      actorUserId: ownerId,
      reason: 'spam',
    });

    const stillMember = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId: memberId } },
    });
    expect(stillMember).toBeNull();

    const banRow = await prisma.serverBan.findUnique({
      where: { serverId_userId: { serverId, userId: memberId } },
    });
    expect(banRow).not.toBeNull();
    expect(banRow!.reason).toBe('spam');
    expect(banRow!.bannedByUserId).toBe(ownerId);

    expect(await isBanned(serverId, memberId)).toBe(true);
  });

  it('refuses to ban the server owner', async () => {
    const { ownerId, memberId, serverId } = await makeServerWithOwner();
    const { banMember } = await import('../src/services/ban-service.js');

    // Member is not the owner — but if we ask to ban ownerId, it should fail.
    await expect(
      banMember({ serverId, targetUserId: ownerId, actorUserId: memberId }),
    ).rejects.toThrow();
  });

  it('unban removes the row and isBanned returns false', async () => {
    const { ownerId, memberId, serverId } = await makeServerWithOwner();
    const { banMember, unbanMember, isBanned } = await import('../src/services/ban-service.js');

    await banMember({ serverId, targetUserId: memberId, actorUserId: ownerId });
    await unbanMember({ serverId, targetUserId: memberId, actorUserId: ownerId });
    expect(await isBanned(serverId, memberId)).toBe(false);
  });

  it('expired bans are pruned and reported as not banned', async () => {
    const { ownerId, memberId, serverId } = await makeServerWithOwner();
    const { banMember, isBanned } = await import('../src/services/ban-service.js');

    await banMember({
      serverId,
      targetUserId: memberId,
      actorUserId: ownerId,
      expiresAt: new Date(Date.now() + 10_000), // 10s
    });
    // Roll the clock backwards in the row.
    await prisma.serverBan.update({
      where: { serverId_userId: { serverId, userId: memberId } },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await isBanned(serverId, memberId)).toBe(false);
    const after = await prisma.serverBan.findUnique({
      where: { serverId_userId: { serverId, userId: memberId } },
    });
    expect(after).toBeNull();
  });

  it('activeBanServerIds returns the set of currently banned servers', async () => {
    const { ownerId, memberId, serverId } = await makeServerWithOwner();
    const { banMember, activeBanServerIds } = await import('../src/services/ban-service.js');

    expect(await activeBanServerIds(memberId)).toEqual(new Set());
    await banMember({ serverId, targetUserId: memberId, actorUserId: ownerId });
    const banned = await activeBanServerIds(memberId);
    expect(banned.has(serverId)).toBe(true);
  });
});
