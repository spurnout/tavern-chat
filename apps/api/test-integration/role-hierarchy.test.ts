/**
 * Integration test for the role-hierarchy guard added in Phase 3a (PERM-001).
 *
 * The guard fires inside `requireRoleHierarchy`, gating role-mutation routes
 * so MANAGE_ROLES alone is no longer enough to grant a role above your own
 * or with permissions you don't yourself hold. We exercise the service
 * function directly here; a separate route test would add HTTP-layer scaffolding
 * without changing the assertions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  Permission,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_NONE,
  serializePermissions,
  TavernError,
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

describe.skipIf(!dockerOk)('role hierarchy (PERM-001)', () => {
  it('owner bypasses every hierarchy check', async () => {
    const ownerId = ulid();
    const serverId = ulid();
    const everyoneId = ulid();
    const elevatedId = ulid();

    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'owner-h',
        usernameLower: 'owner-h',
        displayName: 'Owner',
        email: 'owner-h@example.com',
        emailLower: 'owner-h@example.com',
        passwordHash: 'x',
      },
    });
    await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'S' } });
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
    await prisma.role.create({
      data: {
        id: elevatedId,
        serverId,
        name: 'God-mode',
        position: 99,
        permissions: new Prisma.Decimal(serializePermissions(PERMISSION_ALL)),
      },
    });

    const { requireRoleHierarchy } = await import('../src/services/permissions-service.js');

    // Owner passes — they're allowed to manage any role, anywhere.
    await expect(
      requireRoleHierarchy(serverId, ownerId, [
        { position: 99, permissions: PERMISSION_ALL },
      ]),
    ).resolves.toBeUndefined();
  });

  it('mid-tier MANAGE_ROLES holder cannot grant ADMINISTRATOR', async () => {
    const ownerId = ulid();
    const modId = ulid();
    const serverId = ulid();
    const everyoneId = ulid();
    const modRoleId = ulid();
    const adminRoleId = ulid();

    for (const [id, name] of [
      [ownerId, 'owner-h2'],
      [modId, 'mod-h2'],
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
    await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'S2' } });
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
    await prisma.role.create({
      data: {
        id: modRoleId,
        serverId,
        name: 'Mod',
        position: 10,
        // Holds MANAGE_ROLES, but not ADMINISTRATOR.
        permissions: new Prisma.Decimal(serializePermissions(Permission.MANAGE_ROLES)),
      },
    });
    await prisma.role.create({
      data: {
        id: adminRoleId,
        serverId,
        name: 'Admin',
        position: 5,
        permissions: new Prisma.Decimal(serializePermissions(Permission.ADMINISTRATOR)),
      },
    });
    await prisma.serverMember.create({ data: { serverId, userId: modId } });
    await prisma.serverMemberRole.create({
      data: { serverId, userId: modId, roleId: modRoleId },
    });

    const { requireRoleHierarchy } = await import('../src/services/permissions-service.js');

    // The mod cannot grant a role that carries permissions they don't hold.
    await expect(
      requireRoleHierarchy(serverId, modId, [
        { position: 5, permissions: Permission.ADMINISTRATOR },
      ]),
    ).rejects.toBeInstanceOf(TavernError);
  });

  it('cannot manage a role at or above the actor', async () => {
    const ownerId = ulid();
    const modId = ulid();
    const serverId = ulid();
    const everyoneId = ulid();
    const modRoleId = ulid();
    const targetRoleId = ulid();

    for (const [id, name] of [
      [ownerId, 'owner-h3'],
      [modId, 'mod-h3'],
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
    await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'S3' } });
    await prisma.role.create({
      data: {
        id: everyoneId,
        serverId,
        name: '@everyone',
        isEveryone: true,
        permissions: new Prisma.Decimal(serializePermissions(PERMISSION_NONE)),
      },
    });
    await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
    await prisma.role.create({
      data: {
        id: modRoleId,
        serverId,
        name: 'Mod',
        position: 10,
        permissions: new Prisma.Decimal(serializePermissions(Permission.MANAGE_ROLES)),
      },
    });
    await prisma.role.create({
      data: {
        id: targetRoleId,
        serverId,
        name: 'TopMod',
        position: 10, // Same position as the actor's highest role.
        permissions: new Prisma.Decimal(serializePermissions(PERMISSION_NONE)),
      },
    });
    await prisma.serverMember.create({ data: { serverId, userId: modId } });
    await prisma.serverMemberRole.create({
      data: { serverId, userId: modId, roleId: modRoleId },
    });

    const { requireRoleHierarchy } = await import('../src/services/permissions-service.js');

    await expect(
      requireRoleHierarchy(serverId, modId, [
        { position: 10, permissions: PERMISSION_NONE },
      ]),
    ).rejects.toBeInstanceOf(TavernError);
  });
});
