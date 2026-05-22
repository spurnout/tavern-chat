/**
 * P3-11 — per-channel federation mode (inherit / force_on / force_off).
 *
 * Coverage matrix:
 *   1. Round-trip: an admin (server owner) PATCHes federationMode='force_on';
 *      the next GET returns it. Then PATCH back to 'inherit' and verify GET
 *      reflects that too.
 *   2. Bad enum value rejected: PATCH federationMode='bogus' returns 400 and
 *      the row keeps its prior value.
 *   3. Non-admin rejected: a regular member's PATCH returns 403 and the
 *      database row is unchanged.
 *
 * Mirrors the auth and bootstrap pattern from
 * server-federation-toggle.test.ts (P3-10).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
  type Channel as ChannelDto,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';

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

interface Fixture {
  ownerId: string;
  memberId: string;
  serverId: string;
  channelId: string;
}

async function makeFixture(): Promise<Fixture> {
  const ownerId = ulid();
  const memberId = ulid();
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  for (const [id, name] of [
    [ownerId, `owner-${ownerId.slice(-6).toLowerCase()}`],
    [memberId, `member-${memberId.slice(-6).toLowerCase()}`],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: name,
        usernameLower: name,
        displayName: name,
        email: `${name}@example.test`,
        emailLower: `${name}@example.test`,
        passwordHash: 'x',
      },
    });
  }
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Federation Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneId },
  });
  await prisma.channel.create({
    data: { id: channelId, serverId, type: 'text', name: 'general' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  await prisma.serverMember.create({ data: { serverId, userId: memberId } });
  return { ownerId, memberId, serverId, channelId };
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: { id: ulid(), userId, label: 'test', tokenHash: hash },
  });
  return raw;
}

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: 'https://self.example',
  } as NodeJS.ProcessEnv;
}

describe.skipIf(!dockerOk)('P3-11 — per-channel federation mode', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.auditLogEntry.deleteMany({});
    await prisma.apiToken.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
    vi.restoreAllMocks();
  });

  it('round-trips: admin PATCHes federationMode=force_on, GET reflects it, then back to inherit', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const headers = { authorization: `Bearer ${token}` };

      // GET pre-flip — default is 'inherit'.
      const before = await app.inject({
        method: 'GET',
        url: `/api/channels/${fx.channelId}`,
        headers,
      });
      expect(before.statusCode).toBe(200);
      const beforeBody = before.json() as { data: ChannelDto };
      expect(beforeBody.data.federationMode).toBe('inherit');

      // PATCH → force_on.
      const patchOn = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers,
        payload: { federationMode: 'force_on' },
      });
      expect(patchOn.statusCode).toBe(200);
      const patchOnBody = patchOn.json() as { data: ChannelDto };
      expect(patchOnBody.data.federationMode).toBe('force_on');

      // GET reflects the flip.
      const afterOn = await app.inject({
        method: 'GET',
        url: `/api/channels/${fx.channelId}`,
        headers,
      });
      const afterOnBody = afterOn.json() as { data: ChannelDto };
      expect(afterOnBody.data.federationMode).toBe('force_on');

      // Database row is the source of truth.
      const row = await prisma.channel.findUnique({ where: { id: fx.channelId } });
      expect(row?.federationMode).toBe('force_on');

      // PATCH back to inherit.
      const patchInherit = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers,
        payload: { federationMode: 'inherit' },
      });
      expect(patchInherit.statusCode).toBe(200);
      const patchInheritBody = patchInherit.json() as { data: ChannelDto };
      expect(patchInheritBody.data.federationMode).toBe('inherit');

      const afterInherit = await prisma.channel.findUnique({ where: { id: fx.channelId } });
      expect(afterInherit?.federationMode).toBe('inherit');
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid enum value with 400', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      // Pre-set a known value so we can prove the bad PATCH didn't clobber it.
      await prisma.channel.update({
        where: { id: fx.channelId },
        data: { federationMode: 'force_off' },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { federationMode: 'bogus' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');

      // Prior value survives unchanged.
      const row = await prisma.channel.findUnique({ where: { id: fx.channelId } });
      expect(row?.federationMode).toBe('force_off');
    } finally {
      await app.close();
    }
  });

  it('rejects a regular member (no MANAGE_CHANNELS) with 403', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const memberToken = await mintToken(fx.memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/channels/${fx.channelId}`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { federationMode: 'force_on' },
      });
      expect(res.statusCode).toBe(403);
      // The mode definitely did not persist.
      const row = await prisma.channel.findUnique({ where: { id: fx.channelId } });
      expect(row?.federationMode).toBe('inherit');
    } finally {
      await app.close();
    }
  });
});
