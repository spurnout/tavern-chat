/**
 * Integration test for the permission resolver against a real Postgres.
 *
 * We only run if Docker is available. On developer machines without Docker
 * (or in environments where testcontainers can't bind), the suite skips
 * gracefully so it never fails CI by accident.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  Permission,
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
  // The `@tavern/db` package builds its singleton PrismaClient at module load
  // and reads DATABASE_URL once. We point it at the testcontainer BEFORE
  // anything dynamically imports it.
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

describe.skipIf(!dockerOk)('permissions integration', () => {
  it('resolves channel permissions with overwrites against a real DB', async () => {
    const ownerId = ulid();
    const memberId = ulid();
    const serverId = ulid();
    const everyoneRoleId = ulid();
    const channelId = ulid();

    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'owner',
        usernameLower: 'owner',
        displayName: 'Owner',
        email: 'owner@example.com',
        emailLower: 'owner@example.com',
        passwordHash: 'x',
      },
    });
    await prisma.user.create({
      data: {
        id: memberId,
        username: 'member',
        usernameLower: 'member',
        displayName: 'Member',
        email: 'member@example.com',
        emailLower: 'member@example.com',
        passwordHash: 'x',
      },
    });

    await prisma.server.create({
      data: { id: serverId, ownerUserId: ownerId, name: 'Test' },
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
    await prisma.serverMember.create({ data: { serverId, userId: memberId } });
    await prisma.channel.create({
      data: { id: channelId, serverId, type: 'text', name: 'lobby' },
    });

    // Lazy import so we test the actual service module.
    const { getChannelPermissions } = await import('../src/services/permissions-service.js');

    // Member can view by default.
    const before = await getChannelPermissions(channelId, memberId);
    expect(before).not.toBeNull();
    expect((before!.perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL).toBe(true);

    // Add an @everyone overwrite that denies VIEW_CHANNEL — member should
    // lose access; owner should still have everything.
    await prisma.permissionOverwrite.create({
      data: {
        id: ulid(),
        channelId,
        targetType: 'role',
        targetId: everyoneRoleId,
        deny: new Prisma.Decimal(serializePermissions(Permission.VIEW_CHANNEL)),
      },
    });

    const after = await getChannelPermissions(channelId, memberId);
    expect(after).not.toBeNull();
    expect((after!.perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL).toBe(false);

    const ownerPerms = await getChannelPermissions(channelId, ownerId);
    expect(ownerPerms).not.toBeNull();
    expect((ownerPerms!.perms & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL).toBe(true);
  });
});
