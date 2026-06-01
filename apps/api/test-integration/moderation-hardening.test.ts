/**
 * Integration coverage for parity gap #4: AutoMod presets, raid protection
 * config, and the verification posting gate.
 *
 *   GET/POST/DELETE /api/servers/:id/automod/presets[/:presetId]
 *   GET/PUT         /api/servers/:id/raid-protection (+ /lift)
 *   PATCH           /api/servers/:id  (verificationLevel)
 *
 * The verification gate is exercised through message-create on a real channel.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { ulid, PERMISSION_ALL } from '@tavern/shared';
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

async function makeUser(slug: string, createdAt?: Date): Promise<string> {
  const id = ulid();
  const uname = `${slug}-${id.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username: uname,
      usernameLower: uname,
      displayName: uname,
      email: `${uname}@example.test`,
      emailLower: `${uname}@example.test`,
      passwordHash: 'x',
      ...(createdAt ? { createdAt } : {}),
    },
  });
  return id;
}

/** Server with owner, an @everyone role granting all perms, and one text room. */
async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string; everyoneRoleId: string }> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Mod Tavern' } });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: PERMISSION_ALL.toString(),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneRoleId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  const channelId = ulid();
  await prisma.channel.create({ data: { id: channelId, serverId, name: 'general', type: 'text' } });
  return { serverId, channelId, everyoneRoleId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
  } as NodeJS.ProcessEnv;
}

async function buildTestApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envFor(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

type OkBody<T> = { ok: true; data: T };

describe.skipIf(!dockerOk)('Moderation hardening', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.automodRule.deleteMany({});
    await prisma.raidProtectionConfig.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('enables and disables an automod preset, seeding/removing rules', async () => {
    const owner = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(owner);
    const app = await buildTestApp();
    try {
      const auth = { authorization: `Bearer ${await mintToken(owner)}` };
      let res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/automod/presets/invite-link-spam`,
        headers: auth,
      });
      expect(res.statusCode).toBe(201);
      expect(await prisma.automodRule.count({ where: { serverId, presetId: 'invite-link-spam' } })).toBeGreaterThan(0);

      // Idempotent re-enable.
      res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/automod/presets/invite-link-spam`,
        headers: auth,
      });
      expect((res.json() as OkBody<{ created: number }>).data.created).toBe(0);

      // Disable removes them.
      res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}/automod/presets/invite-link-spam`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(await prisma.automodRule.count({ where: { serverId, presetId: 'invite-link-spam' } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('round-trips raid protection config and lifts a lockdown', async () => {
    const owner = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(owner);
    const app = await buildTestApp();
    try {
      const auth = { authorization: `Bearer ${await mintToken(owner)}` };
      let res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/raid-protection`,
        headers: auth,
        payload: { enabled: true, joinWindowSec: 30, joinThreshold: 5, lockdownAction: 'pause_invites' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as OkBody<{ enabled: boolean; joinThreshold: number }>).data.joinThreshold).toBe(5);

      // Simulate an active lockdown then lift it.
      await prisma.raidProtectionConfig.update({
        where: { serverId },
        data: { lockdownActive: true, lockdownEndsAt: new Date(Date.now() + 60_000) },
      });
      res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/raid-protection/lift`,
        headers: auth,
      });
      expect((res.json() as OkBody<{ lockdownActive: boolean }>).data.lockdownActive).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('blocks posting under account_age verification for a too-new member', async () => {
    const owner = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(owner);
    // Brand-new member.
    const newbie = await makeUser('newbie');
    await addMember(serverId, newbie);

    const app = await buildTestApp();
    try {
      const ownerAuth = { authorization: `Bearer ${await mintToken(owner)}` };
      // Require 24h account age.
      await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: ownerAuth,
        payload: { verificationLevel: 'account_age', verificationMinAccountAgeHours: 24 },
      });

      const newbieAuth = { authorization: `Bearer ${await mintToken(newbie)}` };
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: newbieAuth,
        payload: { content: 'hi' },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('VERIFICATION_REQUIRED');
    } finally {
      await app.close();
    }
  });
});
