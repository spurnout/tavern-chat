/**
 * Tavern dev seed.
 *
 *   - admin user (admin@example.com / change-me-in-dev)
 *   - DEV-INVITE invite code
 *   - default "The Tavern" server with #lobby and a Voice Hall channel
 *
 * Re-runnable: uses upserts so calling this multiple times is safe.
 */

import argon2 from 'argon2';
import { Prisma, PrismaClient, ChannelType } from '@prisma/client';
import {
  Permission,
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_DISPLAY_NAME = process.env.SEED_ADMIN_DISPLAY_NAME ?? 'Innkeeper';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-in-dev';
const SEED_INVITE_CODE = process.env.SEED_INVITE_CODE ?? 'DEV-INVITE';
const SEED_SERVER_NAME = process.env.SEED_SERVER_NAME ?? 'The Tavern';

async function main(): Promise<void> {
  // ---- admin user --------------------------------------------------------
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 1 << 16,
    timeCost: 3,
    parallelism: 1,
  });

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      isInstanceAdmin: true,
    },
    create: {
      id: ulid(),
      username: ADMIN_USERNAME,
      usernameLower: ADMIN_USERNAME.toLowerCase(),
      displayName: ADMIN_DISPLAY_NAME,
      email: ADMIN_EMAIL,
      emailLower: ADMIN_EMAIL.toLowerCase(),
      passwordHash,
      isInstanceAdmin: true,
    },
  });
  console.info(`[seed] admin user ready: ${admin.username} <${admin.email}>`);

  // ---- instance invite ---------------------------------------------------
  await prisma.invite.upsert({
    where: { code: SEED_INVITE_CODE },
    update: {},
    create: {
      id: ulid(),
      code: SEED_INVITE_CODE,
      scope: 'instance',
      createdById: admin.id,
      maxUses: null,
      expiresAt: null,
    },
  });
  console.info(`[seed] instance invite ready: ${SEED_INVITE_CODE}`);

  // ---- default server ----------------------------------------------------
  const existingServer = await prisma.server.findFirst({
    where: { name: SEED_SERVER_NAME, ownerUserId: admin.id },
  });

  if (existingServer) {
    console.info(`[seed] server "${SEED_SERVER_NAME}" already exists, skipping`);
    return;
  }

  const serverId = ulid();
  const everyoneRoleId = ulid();
  const lobbyChannelId = ulid();
  const voiceChannelId = ulid();

  await prisma.$transaction(async (tx) => {
    await tx.server.create({
      data: {
        id: serverId,
        ownerUserId: admin.id,
        name: SEED_SERVER_NAME,
        description: 'Pull up a chair, friend.',
      },
    });

    await tx.role.create({
      data: {
        id: everyoneRoleId,
        serverId,
        name: '@everyone',
        color: 0,
        position: 0,
        isEveryone: true,
        permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
      },
    });

    await tx.server.update({
      where: { id: serverId },
      data: { defaultRoleId: everyoneRoleId },
    });

    await tx.serverMember.create({
      data: {
        serverId,
        userId: admin.id,
      },
    });

    await tx.channel.create({
      data: {
        id: lobbyChannelId,
        serverId,
        type: ChannelType.text,
        name: 'lobby',
        topic: 'Welcome to the Tavern. Hang up your cloak.',
        position: 0,
      },
    });

    await tx.channel.create({
      data: {
        id: voiceChannelId,
        serverId,
        type: ChannelType.voice,
        name: 'Voice Hall',
        position: 1,
      },
    });

    await tx.safetyPolicy.create({
      data: {
        serverId,
        sfwOnly: false,
        allowNsfwChannels: true,
        spoilerTagsEnabled: true,
        profanityFilter: 'off',
        uploadDomainAllowlist: [],
        uploadDomainBlocklist: [],
        blockExecutableUploads: true,
        blockArchiveUploads: true,
        stripImageMetadata: true,
      },
    });

    // System welcome message — using Permission flag just to silence "unused" lint.
    void Permission;
    await tx.message.create({
      data: {
        id: ulid(),
        serverId,
        channelId: lobbyChannelId,
        authorId: admin.id,
        type: 'system',
        content: `Welcome to ${SEED_SERVER_NAME}.`,
      },
    });
  });

  console.info(`[seed] server ready: ${SEED_SERVER_NAME} (${serverId})`);
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
