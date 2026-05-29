/**
 * Integration coverage for the server-scoped board-game surface in
 * `apps/api/src/routes/board-games.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - list (GET)     : caller must be a server member (permissions > 0n); outsider → 404
 *   - create (POST)  : requires MANAGE_BOARD_GAMES; missing bit → 403
 *   - update (PATCH) : requires MANAGE_BOARD_GAMES on the game's server; missing bit → 403
 *   - delete (DELETE): requires MANAGE_BOARD_GAMES on the game's server; missing bit → 403
 *   - server owner bypasses the MANAGE_BOARD_GAMES gate (computeBasePermissions → PERMISSION_ALL)
 *
 * Fixtures: a server owned by `ownerId` with an @everyone role (default
 * perms, no MANAGE_BOARD_GAMES) + one text channel. A separate `member` user
 * is added as an @everyone-only server member. Federation is off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, Permission, serializePermissions, ulid } from '@tavern/shared';
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

// ---------------------------------------------------------------------------
// Helpers
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
  channelId: string;
}

/**
 * Server owned by `ownerId` with an @everyone role + one text channel.
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset so
 * individual tests can grant MANAGE_BOARD_GAMES to plain members.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'BoardGame Tavern' } });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE | extraEveryonePerms),
      ),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'table' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Directly create a board-game row (used to seed PATCH/DELETE fixtures). */
async function makeBoardGame(
  serverId: string,
  ownerUserId: string,
  overrides: Partial<{
    name: string;
    minPlayers: number;
    maxPlayers: number;
    playTimeMinutes: number;
    complexity: number;
    tags: string[];
  }> = {},
): Promise<string> {
  const id = ulid();
  await prisma.boardGame.create({
    data: {
      id,
      serverId,
      ownerUserId,
      name: overrides.name ?? 'Catan',
      minPlayers: overrides.minPlayers ?? 2,
      maxPlayers: overrides.maxPlayers ?? 4,
      playTimeMinutes: overrides.playTimeMinutes ?? null,
      complexity: overrides.complexity ?? null,
      tags: overrides.tags ?? [],
    },
  });
  return id;
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
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('board-game routes (apps/api/src/routes/board-games.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.gameNightVote.deleteMany({});
    await prisma.gameNightCandidate.deleteMany({});
    await prisma.gameNight.deleteMany({});
    await prisma.boardGame.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // =========================================================================
  // GET /api/servers/:serverId/board-games
  // =========================================================================

  it('lists board games for a server member (200, ordered by name asc)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeBoardGame(serverId, ownerId, { name: 'Twilight Imperium', minPlayers: 3, maxPlayers: 6 });
    await makeBoardGame(serverId, ownerId, { name: 'Azul', minPlayers: 2, maxPlayers: 4 });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; name: string; serverId: string }>>;
      expect(body.ok).toBe(true);
      expect(body.data.map((g) => g.name)).toEqual(['Azul', 'Twilight Imperium']);
      expect(body.data.every((g) => g.serverId === serverId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET list returns 404 for a server the caller is not a member of', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    // outsiderId never added as a member

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET list returns 401 without a token', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET list returns 404 for an unknown server', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/board-games`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET list filters by players count', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeBoardGame(serverId, ownerId, { name: 'Catan', minPlayers: 3, maxPlayers: 4 });
    await makeBoardGame(serverId, ownerId, { name: 'Chess', minPlayers: 2, maxPlayers: 2 });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games?players=2`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ name: string }>>;
      // Catan requires min 3, so only Chess fits for 2 players
      expect(body.data.map((g) => g.name)).toEqual(['Chess']);
    } finally {
      await app.close();
    }
  });

  it('GET list filters by maxPlayTimeMinutes', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeBoardGame(serverId, ownerId, { name: 'Quick', minPlayers: 2, maxPlayers: 4, playTimeMinutes: 30 });
    await makeBoardGame(serverId, ownerId, { name: 'Epic', minPlayers: 2, maxPlayers: 6, playTimeMinutes: 240 });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games?maxPlayTimeMinutes=60`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ name: string }>>;
      expect(body.data.map((g) => g.name)).toEqual(['Quick']);
    } finally {
      await app.close();
    }
  });

  it('GET list filters by maxComplexity', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeBoardGame(serverId, ownerId, { name: 'Easy', minPlayers: 2, maxPlayers: 4, complexity: 1.5 });
    await makeBoardGame(serverId, ownerId, { name: 'Hard', minPlayers: 2, maxPlayers: 4, complexity: 4.5 });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games?maxComplexity=2`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ name: string }>>;
      expect(body.data.map((g) => g.name)).toEqual(['Easy']);
    } finally {
      await app.close();
    }
  });

  it('GET list filters by tag', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeBoardGame(serverId, ownerId, { name: 'Tagged', tags: ['strategy', 'euro'] });
    await makeBoardGame(serverId, ownerId, { name: 'Untagged', tags: [] });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games?tag=euro`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ name: string }>>;
      expect(body.data.map((g) => g.name)).toEqual(['Tagged']);
    } finally {
      await app.close();
    }
  });

  it('GET list filters by name search (case-insensitive)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeBoardGame(serverId, ownerId, { name: 'Pandemic Legacy' });
    await makeBoardGame(serverId, ownerId, { name: 'Catan' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/board-games?search=pandemic`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ name: string }>>;
      expect(body.data.map((g) => g.name)).toEqual(['Pandemic Legacy']);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // POST /api/servers/:serverId/board-games
  // =========================================================================

  it('server owner can create a board game (201) and row appears in DB', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Wingspan',
          minPlayers: 1,
          maxPlayers: 5,
          playTimeMinutes: 70,
          complexity: 2.5,
          tags: ['strategy', 'birds'],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        serverId: string;
        name: string;
        minPlayers: number;
        maxPlayers: number;
        playTimeMinutes: number | null;
        complexity: number | null;
        ownerUserId: string | null;
        tags: string[];
        createdAt: string;
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('Wingspan');
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.minPlayers).toBe(1);
      expect(body.data.maxPlayers).toBe(5);
      expect(body.data.playTimeMinutes).toBe(70);
      expect(body.data.tags).toEqual(['strategy', 'birds']);
      // ownerUserId defaults to caller when not specified
      expect(body.data.ownerUserId).toBe(ownerId);

      const row = await prisma.boardGame.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.name).toBe('Wingspan');
      expect(row.serverId).toBe(serverId);
    } finally {
      await app.close();
    }
  });

  it('member with MANAGE_BOARD_GAMES can create a board game (201)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_BOARD_GAMES);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ticket to Ride', minPlayers: 2, maxPlayers: 5 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; ownerUserId: string | null }>;
      expect(body.data.ownerUserId).toBe(memberId);
    } finally {
      await app.close();
    }
  });

  it('member without MANAGE_BOARD_GAMES cannot create a board game (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // no extra perms
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Forbidden Island', minPlayers: 2, maxPlayers: 4 },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.boardGame.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${ulid()}/board-games`,
        payload: { name: 'Ghost Game', minPlayers: 2, maxPlayers: 4 },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST returns 400 when name is empty', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '', minPlayers: 2, maxPlayers: 4 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST returns 400 when minPlayers exceeds maxPlayers', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Impossible', minPlayers: 5, maxPlayers: 2 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST returns 400 when required fields (minPlayers) are missing', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'No Players' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST sets ownerUserId to caller when not provided', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/board-games`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Solo Game', minPlayers: 1, maxPlayers: 1 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ ownerUserId: string | null }>;
      expect(body.data.ownerUserId).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // PATCH /api/board-games/:id
  // =========================================================================

  it('server owner can update a board game (200) and changes persist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'Before', minPlayers: 2, maxPlayers: 4 });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'After', tags: ['updated'] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; name: string; tags: string[] }>;
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('After');
      expect(body.data.tags).toEqual(['updated']);

      const row = await prisma.boardGame.findUniqueOrThrow({ where: { id: gameId } });
      expect(row.name).toBe('After');
      expect(row.tags).toEqual(['updated']);
    } finally {
      await app.close();
    }
  });

  it('member with MANAGE_BOARD_GAMES can update a board game (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_BOARD_GAMES);
    await addMember(serverId, memberId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'Original' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Renamed', playTimeMinutes: 90 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string; playTimeMinutes: number | null }>;
      expect(body.data.name).toBe('Renamed');
      expect(body.data.playTimeMinutes).toBe(90);
    } finally {
      await app.close();
    }
  });

  it('member without MANAGE_BOARD_GAMES cannot update a board game (403), value unchanged', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // no extra perms
    await addMember(serverId, memberId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'Locked' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);

      const row = await prisma.boardGame.findUniqueOrThrow({ where: { id: gameId } });
      expect(row.name).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 404 for an unknown board game', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/board-games/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/board-games/${ulid()}`,
        payload: { name: 'Anon' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('PATCH ignores unknown fields and does not error (partial update)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'Stable', minPlayers: 2, maxPlayers: 4 });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      // Send only description (other fields unchanged)
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { description: 'A great game' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string; description: string | null }>;
      expect(body.data.name).toBe('Stable');
      expect(body.data.description).toBe('A great game');
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // DELETE /api/board-games/:id
  // =========================================================================

  it('server owner can delete a board game (200) and row is gone', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'Doomed' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(gameId);

      const row = await prisma.boardGame.findUnique({ where: { id: gameId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('member with MANAGE_BOARD_GAMES can delete a board game (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_BOARD_GAMES);
    await addMember(serverId, memberId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'To Delete' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.boardGame.findUnique({ where: { id: gameId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('member without MANAGE_BOARD_GAMES cannot delete a board game (403), row survives', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // no extra perms
    await addMember(serverId, memberId);
    const gameId = await makeBoardGame(serverId, ownerId, { name: 'Survivor' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/board-games/${gameId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);

      const row = await prisma.boardGame.findUnique({ where: { id: gameId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE returns 404 for an unknown board game', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/board-games/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE returns 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/board-games/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
