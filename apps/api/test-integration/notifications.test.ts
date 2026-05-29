/**
 * Integration coverage for the notification-preference surface in
 * `apps/api/src/routes/notifications.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Routes under test:
 *   GET  /api/me/notification-preferences
 *   PATCH /api/me/notification-preferences
 *   GET  /api/servers/:serverId/notification-preferences/me
 *   PATCH /api/servers/:serverId/notification-preferences/me
 *
 * Auth model:
 *   - Every handler calls `app.requireUser` → 401 when no bearer token.
 *   - User-pref routes are scoped strictly to the caller; no cross-user access
 *     is possible (the userId comes from the auth context).
 *   - Server-pref routes call `getServerPermissions`; if the result is 0n (the
 *     user is not a member of the server or the server doesn't exist) the
 *     handler throws `TavernError.notFound` → 404. A valid member always
 *     resolves the preference lazily (upsert-on-read).
 *
 * Preferences are upserted lazily: the first GET creates defaults, subsequent
 * PATCHes apply only the supplied fields.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, serializePermissions, ulid } from '@tavern/shared';
import {
  isDockerAvailable,
  resetDb,
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

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeUser(slug: string): Promise<string> {
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
    },
  });
  return id;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

interface ServerFixture {
  serverId: string;
  everyoneId: string;
}

async function makeServer(ownerId: string): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Notif Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'general' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)(
  'notification preference routes (apps/api/src/routes/notifications.ts)',
  () => {
    beforeEach(async () => {
      if (!dockerOk) return;
      await resetDb(prisma);
    });

    // ---- GET /api/me/notification-preferences ----------------------------

    it('GET /api/me/notification-preferences returns defaults (200) when no row exists yet', async () => {
      const userId = await makeUser('alice');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          soundEnabled: boolean;
          volume: number;
          chatSoundsWhileInVoice: boolean;
          playOnlyWhenUnfocused: boolean;
          mentionsOverrideMute: boolean;
          snoozeUntil: string | null;
          quietHoursStart: string | null;
          quietHoursEnd: string | null;
          quietHoursDays: number[];
        }>;
        expect(body.ok).toBe(true);
        // Defaults from route: soundEnabled true, volume 70, chatSoundsWhileInVoice false,
        // playOnlyWhenUnfocused true, mentionsOverrideMute true.
        expect(body.data.soundEnabled).toBe(true);
        expect(body.data.volume).toBe(70);
        expect(body.data.chatSoundsWhileInVoice).toBe(false);
        expect(body.data.playOnlyWhenUnfocused).toBe(true);
        expect(body.data.mentionsOverrideMute).toBe(true);
        expect(body.data.snoozeUntil).toBeNull();
        expect(body.data.quietHoursDays).toEqual([]);
        // Row was created lazily in the DB.
        const row = await prisma.userNotificationPreference.findUnique({ where: { userId } });
        expect(row).not.toBeNull();
        expect(row!.soundEnabled).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('GET /api/me/notification-preferences without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/me/notification-preferences',
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('GET /api/me/notification-preferences returns the stored pref when it already exists', async () => {
      const userId = await makeUser('bob');
      await prisma.userNotificationPreference.create({
        data: {
          userId,
          soundEnabled: false,
          volume: 30,
          chatSoundsWhileInVoice: true,
          playOnlyWhenUnfocused: false,
          mentionsOverrideMute: false,
          quietHoursDays: [],
        },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ soundEnabled: boolean; volume: number }>;
        expect(body.data.soundEnabled).toBe(false);
        expect(body.data.volume).toBe(30);
      } finally {
        await app.close();
      }
    });

    // ---- PATCH /api/me/notification-preferences --------------------------

    it('PATCH /api/me/notification-preferences updates only the supplied fields (200)', async () => {
      const userId = await makeUser('carol');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        // Seed defaults via GET.
        await app.inject({
          method: 'GET',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${token}` },
        });

        const res = await app.inject({
          method: 'PATCH',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${token}` },
          payload: { volume: 50, soundEnabled: false },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ volume: number; soundEnabled: boolean; playOnlyWhenUnfocused: boolean }>;
        expect(body.data.volume).toBe(50);
        expect(body.data.soundEnabled).toBe(false);
        // Unpatched field stays at the default.
        expect(body.data.playOnlyWhenUnfocused).toBe(true);

        const row = await prisma.userNotificationPreference.findUniqueOrThrow({ where: { userId } });
        expect(row.volume).toBe(50);
        expect(row.soundEnabled).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('PATCH /api/me/notification-preferences creates the row if it does not exist yet (upsert)', async () => {
      const userId = await makeUser('dan');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const before = await prisma.userNotificationPreference.findUnique({ where: { userId } });
        expect(before).toBeNull();

        const res = await app.inject({
          method: 'PATCH',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${token}` },
          payload: { volume: 20 },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ volume: number }>;
        expect(body.data.volume).toBe(20);

        const row = await prisma.userNotificationPreference.findUnique({ where: { userId } });
        expect(row).not.toBeNull();
        expect(row!.volume).toBe(20);
      } finally {
        await app.close();
      }
    });

    it('PATCH /api/me/notification-preferences with quietHoursDays persists the array', async () => {
      const userId = await makeUser('ellie');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${token}` },
          payload: { quietHoursStart: '22:00', quietHoursEnd: '08:00', quietHoursDays: [1, 3, 5] },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          quietHoursStart: string | null;
          quietHoursEnd: string | null;
          quietHoursDays: number[];
        }>;
        expect(body.data.quietHoursStart).toBe('22:00');
        expect(body.data.quietHoursEnd).toBe('08:00');
        expect(body.data.quietHoursDays).toEqual([1, 3, 5]);
      } finally {
        await app.close();
      }
    });

    it('PATCH /api/me/notification-preferences is isolated per user (user B sees their own defaults)', async () => {
      const userAId = await makeUser('userA');
      const userBId = await makeUser('userB');
      const app = await buildTestApp();
      try {
        const tokenA = await mintToken(userAId);
        const tokenB = await mintToken(userBId);

        // User A patches their volume to 5.
        await app.inject({
          method: 'PATCH',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${tokenA}` },
          payload: { volume: 5 },
        });

        // User B should see the default 70, not A's 5.
        const resB = await app.inject({
          method: 'GET',
          url: '/api/me/notification-preferences',
          headers: { authorization: `Bearer ${tokenB}` },
        });
        expect(resB.statusCode).toBe(200);
        const body = resB.json() as OkBody<{ volume: number }>;
        expect(body.data.volume).toBe(70);
      } finally {
        await app.close();
      }
    });

    it('PATCH /api/me/notification-preferences without token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/me/notification-preferences',
          payload: { volume: 50 },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- GET /api/servers/:serverId/notification-preferences/me ----------

    it('GET server prefs returns defaults (200) for a valid server member', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          serverId: string;
          muteAll: boolean;
          muteMessages: boolean;
          muteMentions: boolean;
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.serverId).toBe(serverId);
        expect(body.data.muteAll).toBe(false);
        expect(body.data.muteMessages).toBe(false);
        expect(body.data.muteMentions).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('GET server prefs returns the stored row when it exists', async () => {
      const ownerId = await makeUser('owner2');
      const { serverId } = await makeServer(ownerId);
      await prisma.serverMemberNotificationPreference.create({
        data: { serverId, userId: ownerId, muteAll: true, muteMessages: true, muteMentions: false },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ muteAll: boolean; muteMessages: boolean; muteMentions: boolean }>;
        expect(body.data.muteAll).toBe(true);
        expect(body.data.muteMessages).toBe(true);
        expect(body.data.muteMentions).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('GET server prefs is 404 for a server the user is not a member of', async () => {
      const ownerId = await makeUser('owner3');
      const nonMemberId = await makeUser('nobody');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(nonMemberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('GET server prefs is 404 for an unknown server id', async () => {
      const userId = await makeUser('ghost');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${ulid()}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('GET server prefs without token is 401', async () => {
      const ownerId = await makeUser('owner4');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/notification-preferences/me`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- PATCH /api/servers/:serverId/notification-preferences/me --------

    it('PATCH server prefs updates the supplied flags (200) and persists to DB', async () => {
      const ownerId = await makeUser('owner5');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
          payload: { muteAll: true },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ serverId: string; muteAll: boolean; muteMessages: boolean }>;
        expect(body.data.serverId).toBe(serverId);
        expect(body.data.muteAll).toBe(true);
        // Unpatched field stays false.
        expect(body.data.muteMessages).toBe(false);

        const row = await prisma.serverMemberNotificationPreference.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(row).not.toBeNull();
        expect(row!.muteAll).toBe(true);
        expect(row!.muteMessages).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('PATCH server prefs creates the row when it does not exist yet (upsert)', async () => {
      const ownerId = await makeUser('owner6');
      const memberId = await makeUser('member6');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const before = await prisma.serverMemberNotificationPreference.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(before).toBeNull();

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
          payload: { muteMessages: true, muteMentions: true },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ muteMessages: boolean; muteMentions: boolean; muteAll: boolean }>;
        expect(body.data.muteMessages).toBe(true);
        expect(body.data.muteMentions).toBe(true);
        expect(body.data.muteAll).toBe(false);

        const row = await prisma.serverMemberNotificationPreference.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('PATCH server prefs is 404 for a server the user is not a member of', async () => {
      const ownerId = await makeUser('owner7');
      const nonMemberId = await makeUser('nobody7');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(nonMemberId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
          payload: { muteAll: true },
        });
        expect(res.statusCode).toBe(404);
        // No row created for the non-member.
        const row = await prisma.serverMemberNotificationPreference.findUnique({
          where: { serverId_userId: { serverId, userId: nonMemberId } },
        });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('PATCH server prefs is 404 for an unknown server id', async () => {
      const userId = await makeUser('ghost2');
      const app = await buildTestApp();
      try {
        const token = await mintToken(userId);
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${ulid()}/notification-preferences/me`,
          headers: { authorization: `Bearer ${token}` },
          payload: { muteAll: true },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('PATCH server prefs without token is 401', async () => {
      const ownerId = await makeUser('owner8');
      const { serverId } = await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}/notification-preferences/me`,
          payload: { muteAll: true },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  },
);
