/**
 * P3-10 — per-Tavern federation toggle, end-to-end through the PATCH
 * /api/servers/:id route.
 *
 * Coverage matrix:
 *   1. Round-trip: an admin (server owner) flips federationEnabled true; the
 *      next GET returns true. Subsequent flip back to false works too.
 *   2. Non-admin rejected: a regular member's PATCH attempt returns 403.
 *   3. Instance-level gate: with FEDERATION_ENABLED=false on the instance,
 *      an admin attempting to set federationEnabled=true gets a 400. Turning
 *      it back to false on a non-federated instance still works (no
 *      false-positive lockout for cleanup flows).
 *
 * The auth flow mints an API personal-access token (tvn_pat_*) for the
 * actor — same shortcut the federation-fanout-create suite uses.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
  type Server as ServerDto,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
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
}

async function makeFixture(): Promise<Fixture> {
  const ownerId = ulid();
  const memberId = ulid();
  const serverId = ulid();
  const everyoneId = ulid();
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
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  await prisma.serverMember.create({ data: { serverId, userId: memberId } });
  return { ownerId, memberId, serverId };
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: { id: ulid(), userId, label: 'test', tokenHash: hash },
  });
  return raw;
}

function envFor(dbUrl: string, federationEnabled: boolean): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: federationEnabled ? 'true' : 'false',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'https://self.example',
  } as NodeJS.ProcessEnv;
}

describe.skipIf(!dockerOk)('P3-10 — per-Tavern federation toggle', () => {
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

  it('round-trips: admin flips federationEnabled on, GET reflects it, then flips off again', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, true)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const headers = { authorization: `Bearer ${token}` };

      // GET pre-flip — initially false (Prisma default).
      const before = await app.inject({ method: 'GET', url: `/api/servers/${fx.serverId}`, headers });
      expect(before.statusCode).toBe(200);
      const beforeBody = before.json() as { data: ServerDto };
      expect(beforeBody.data.federationEnabled).toBe(false);

      // PATCH → true.
      const patchOn = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers,
        payload: { federationEnabled: true },
      });
      expect(patchOn.statusCode).toBe(200);
      const patchOnBody = patchOn.json() as { data: ServerDto };
      expect(patchOnBody.data.federationEnabled).toBe(true);

      // GET reflects the flip.
      const afterOn = await app.inject({ method: 'GET', url: `/api/servers/${fx.serverId}`, headers });
      const afterOnBody = afterOn.json() as { data: ServerDto };
      expect(afterOnBody.data.federationEnabled).toBe(true);

      // Database row is the source of truth.
      const row = await prisma.server.findUnique({ where: { id: fx.serverId } });
      expect(row?.federationEnabled).toBe(true);

      // PATCH → false (off→on→off path).
      const patchOff = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers,
        payload: { federationEnabled: false },
      });
      expect(patchOff.statusCode).toBe(200);
      const patchOffBody = patchOff.json() as { data: ServerDto };
      expect(patchOffBody.data.federationEnabled).toBe(false);

      const afterOff = await prisma.server.findUnique({ where: { id: fx.serverId } });
      expect(afterOff?.federationEnabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects a regular member (no MANAGE_SERVER) with 403', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, true)),
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
        url: `/api/servers/${fx.serverId}`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { federationEnabled: true },
      });
      expect(res.statusCode).toBe(403);
      // And the flag definitely did not persist.
      const row = await prisma.server.findUnique({ where: { id: fx.serverId } });
      expect(row?.federationEnabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects federationEnabled=true with 400 when the instance has FEDERATION_ENABLED=false', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl, false)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const ownerToken = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { federationEnabled: true },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // The flag must NOT have persisted.
      const row = await prisma.server.findUnique({ where: { id: fx.serverId } });
      expect(row?.federationEnabled).toBe(false);

      // Sanity: turning OFF on a non-federated instance is still allowed
      // (operators downgrading from FEDERATION_ENABLED=true → false should
      // still be able to clean up tavern flags). The flag is already false
      // here, but the request itself must pass.
      const offRes = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${fx.serverId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { federationEnabled: false },
      });
      expect(offRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
