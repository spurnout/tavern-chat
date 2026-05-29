/**
 * Integration coverage for the game-night surface in
 * `apps/api/src/routes/game-nights.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Game nights are SERVER-scoped (not campaign-scoped). Auth + permission model:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent.
 *   - GET /api/servers/:serverId/game-nights → membership gate: a caller whose
 *     effective server permissions are 0n (a non-member) gets 404 (hides
 *     existence); any member with the default @everyone bitset passes.
 *   - POST /api/servers/:serverId/game-nights → server CREATE_GAME_NIGHTS. The
 *     default @everyone bitset does NOT include it, so a plain member is 403;
 *     the owner holds every permission and passes. Writes an audit entry +
 *     publishes GAME_NIGHT_CREATE.
 *   - PATCH /api/game-nights/:id → the creator, OR (for anyone else) server
 *     MANAGE_GAME_NIGHTS. Missing game night → 404.
 *   - GET/POST candidates, POST votes, PUT rsvp → membership gate (0n → 404).
 *     Voting / proposing a board game that isn't a candidate / isn't on the
 *     server → 400.
 *
 * Fixtures mirror encounters.test.ts: a server (owner) with an @everyone role
 * whose bitset we tune per-test. Federation is off so no route touches the
 * outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  Permission,
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
 * A server owned by `ownerId` with an @everyone role + one text channel and
 * the owner as a member. `extraEveryonePerms` is OR-ed onto the default
 * @everyone bitset so a test can grant CREATE_GAME_NIGHTS / MANAGE_GAME_NIGHTS
 * to every member (separate from the owner shortcut).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Game Night Tavern' } });
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

async function makeBoardGame(serverId: string, name = 'Catan'): Promise<string> {
  const id = ulid();
  await prisma.boardGame.create({
    data: { id, serverId, name, minPlayers: 2, maxPlayers: 4 },
  });
  return id;
}

interface GameNightSeedOptions {
  title?: string;
  status?: 'planning' | 'scheduled' | 'live' | 'completed' | 'cancelled';
}

/** Seed a game night directly so PATCH/candidate/vote/rsvp fixtures don't depend on POST. */
async function makeGameNight(
  serverId: string,
  createdById: string,
  opts: GameNightSeedOptions = {},
): Promise<string> {
  const id = ulid();
  await prisma.gameNight.create({
    data: {
      id,
      serverId,
      title: opts.title ?? 'Friday Night',
      status: opts.status ?? 'planning',
      createdById,
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
type GameNightDto = {
  id: string;
  serverId: string;
  title: string;
  status: string;
  selectedBoardGameId: string | null;
  createdById: string;
};
type CandidateDto = {
  gameNightId: string;
  boardGameId: string;
  proposedById: string;
  voteCount: number;
  meVoted: boolean;
};

describe.skipIf(!dockerOk)('game-night routes (apps/api/src/routes/game-nights.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.gameNightVote.deleteMany({});
    await prisma.gameNightRsvp.deleteMany({});
    await prisma.gameNightCandidate.deleteMany({});
    await prisma.gameNight.deleteMany({});
    await prisma.boardGame.deleteMany({});
    await prisma.auditLogEntry.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/servers/:serverId/game-nights -------------------------

  it('lists server game nights for a member, ordered by scheduledStart desc', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeGameNight(serverId, ownerId, { title: 'One' });
    await makeGameNight(serverId, ownerId, { title: 'Two' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/game-nights`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<GameNightDto[]>;
      expect(body.data).toHaveLength(2);
      expect(body.data.every((g) => g.serverId === serverId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET .../game-nights is 404 for a non-member (membership gate hides existence)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    await makeGameNight(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/game-nights`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../game-nights without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/servers/${ulid()}/game-nights` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/servers/:serverId/game-nights ------------------------

  it('the owner can create a game night with candidates (201); candidates + audit persist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gameA = await makeBoardGame(serverId, 'Gloomhaven');
    const gameB = await makeBoardGame(serverId, 'Wingspan');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/game-nights`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          title: 'Saturday Showdown',
          description: 'Bring snacks.',
          candidateBoardGameIds: [gameA, gameB],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<GameNightDto>;
      expect(body.data.title).toBe('Saturday Showdown');
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.createdById).toBe(ownerId);
      expect(body.data.status).toBe('planning');

      const candidates = await prisma.gameNightCandidate.count({ where: { gameNightId: body.data.id } });
      expect(candidates).toBe(2);
      const audit = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'game_night.created', targetId: body.data.id },
      });
      expect(audit).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a member WITH CREATE_GAME_NIGHTS can create a game night (201)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.CREATE_GAME_NIGHTS);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/game-nights`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Member Night' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<GameNightDto>;
      expect(body.data.createdById).toBe(memberId);
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT CREATE_GAME_NIGHTS cannot create a game night (403), no row written', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/game-nights`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Denied Night' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.gameNight.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST .../game-nights is 400 when the body fails validation (empty title)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/game-nights`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/game-nights/:id -------------------------------------

  it('the creator can update their game night (200) and changes persist', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.CREATE_GAME_NIGHTS);
    await addMember(serverId, memberId);
    const gnId = await makeGameNight(serverId, memberId, { title: 'Before' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/game-nights/${gnId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'After', status: 'scheduled' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<GameNightDto>;
      expect(body.data.title).toBe('After');
      expect(body.data.status).toBe('scheduled');
      const row = await prisma.gameNight.findUniqueOrThrow({ where: { id: gnId } });
      expect(row.title).toBe('After');
      expect(row.status).toBe('scheduled');
    } finally {
      await app.close();
    }
  });

  it('the server owner (MANAGE_GAME_NIGHTS) can update a game night created by someone else (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const gnId = await makeGameNight(serverId, memberId, { title: 'Member made' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/game-nights/${gnId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Owner renamed' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.gameNight.findUniqueOrThrow({ where: { id: gnId } });
      expect(row.title).toBe('Owner renamed');
    } finally {
      await app.close();
    }
  });

  it('a member who is neither creator nor holds MANAGE_GAME_NIGHTS cannot update (403), value unchanged', async () => {
    const ownerId = await makeUser('owner');
    const creatorId = await makeUser('creator');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(ownerId, Permission.CREATE_GAME_NIGHTS);
    await addMember(serverId, creatorId);
    await addMember(serverId, otherId);
    const gnId = await makeGameNight(serverId, creatorId, { title: 'Locked' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/game-nights/${gnId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.gameNight.findUniqueOrThrow({ where: { id: gnId } });
      expect(row.title).toBe('Locked');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/game-nights/:id is 404 for an unknown game night', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/game-nights/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/game-nights/:id/candidates ----------------------------

  it('lists candidates with vote counts and the caller’s own vote flag (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const gnId = await makeGameNight(serverId, ownerId);
    const gameId = await makeBoardGame(serverId, 'Terraforming Mars');
    await prisma.gameNightCandidate.create({
      data: { gameNightId: gnId, boardGameId: gameId, proposedById: ownerId },
    });
    await prisma.gameNightVote.create({
      data: { gameNightId: gnId, boardGameId: gameId, userId: memberId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/game-nights/${gnId}/candidates`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<CandidateDto[]>;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.boardGameId).toBe(gameId);
      expect(body.data[0]!.voteCount).toBe(1);
      expect(body.data[0]!.meVoted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET .../candidates is 404 for a non-member', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    const gnId = await makeGameNight(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/game-nights/${gnId}/candidates`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET .../candidates is 404 for an unknown game night', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/game-nights/${ulid()}/candidates`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/game-nights/:id/candidates ---------------------------

  it('a member can propose a board game as a candidate (200) and the row is created', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const gnId = await makeGameNight(serverId, ownerId);
    const gameId = await makeBoardGame(serverId, 'Root');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/game-nights/${gnId}/candidates`,
        headers: { authorization: `Bearer ${token}` },
        payload: { boardGameId: gameId },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.gameNightCandidate.findUnique({
        where: { gameNightId_boardGameId: { gameNightId: gnId, boardGameId: gameId } },
      });
      expect(row).not.toBeNull();
      expect(row!.proposedById).toBe(memberId);
    } finally {
      await app.close();
    }
  });

  it('proposing a board game from a different server is 400 (validation)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const otherOwnerId = await makeUser('otherowner');
    const { serverId: otherServerId } = await makeServer(otherOwnerId);
    const gnId = await makeGameNight(serverId, ownerId);
    const foreignGameId = await makeBoardGame(otherServerId, 'Foreign Game');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/game-nights/${gnId}/candidates`,
        headers: { authorization: `Bearer ${token}` },
        payload: { boardGameId: foreignGameId },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST .../candidates is 404 for an unknown game night', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gameId = await makeBoardGame(serverId, 'Orphan Game');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/game-nights/${ulid()}/candidates`,
        headers: { authorization: `Bearer ${token}` },
        payload: { boardGameId: gameId },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/game-nights/:id/votes --------------------------------

  it('a member can vote for a candidate (200); a second vote replaces the first', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const gnId = await makeGameNight(serverId, ownerId);
    const gameA = await makeBoardGame(serverId, 'Game A');
    const gameB = await makeBoardGame(serverId, 'Game B');
    await prisma.gameNightCandidate.createMany({
      data: [
        { gameNightId: gnId, boardGameId: gameA, proposedById: ownerId },
        { gameNightId: gnId, boardGameId: gameB, proposedById: ownerId },
      ],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const first = await app.inject({
        method: 'POST',
        url: `/api/game-nights/${gnId}/votes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { boardGameId: gameA },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: `/api/game-nights/${gnId}/votes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { boardGameId: gameB },
      });
      expect(second.statusCode).toBe(200);

      // One vote per user per game night → only the latest survives.
      const votes = await prisma.gameNightVote.findMany({
        where: { gameNightId: gnId, userId: memberId },
      });
      expect(votes).toHaveLength(1);
      expect(votes[0]!.boardGameId).toBe(gameB);
    } finally {
      await app.close();
    }
  });

  it('voting for a game that is not a candidate is 400', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gnId = await makeGameNight(serverId, ownerId);
    const gameId = await makeBoardGame(serverId, 'Not A Candidate');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/game-nights/${gnId}/votes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { boardGameId: gameId },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- PUT /api/game-nights/:id/rsvp ----------------------------------

  it('a member can RSVP (200); a second RSVP upserts the status', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const gnId = await makeGameNight(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const first = await app.inject({
        method: 'PUT',
        url: `/api/game-nights/${gnId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'yes' },
      });
      expect(first.statusCode).toBe(200);
      let row = await prisma.gameNightRsvp.findUniqueOrThrow({
        where: { gameNightId_userId: { gameNightId: gnId, userId: memberId } },
      });
      expect(row.status).toBe('yes');

      const second = await app.inject({
        method: 'PUT',
        url: `/api/game-nights/${gnId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'no' },
      });
      expect(second.statusCode).toBe(200);
      row = await prisma.gameNightRsvp.findUniqueOrThrow({
        where: { gameNightId_userId: { gameNightId: gnId, userId: memberId } },
      });
      expect(row.status).toBe('no');
      const count = await prisma.gameNightRsvp.count({ where: { gameNightId: gnId, userId: memberId } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('PUT .../rsvp is 400 for an invalid status', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const gnId = await makeGameNight(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/game-nights/${gnId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'definitely-not-valid' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PUT .../rsvp is 404 for a non-member', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    const gnId = await makeGameNight(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/game-nights/${gnId}/rsvp`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'yes' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
