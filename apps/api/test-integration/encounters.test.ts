/**
 * Integration coverage for the initiative-encounter surface in
 * `apps/api/src/routes/encounters.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - encounters are CHANNEL-scoped, not campaign-scoped: every endpoint gates
 *     on a channel permission via `requireChannelPermission`.
 *       · GET active encounter → VIEW_CHANNEL; a non-member sees 404 (the
 *         VIEW_CHANNEL guard hides channel existence).
 *       · create / start / next-turn / participant add|patch|remove / end →
 *         MANAGE_SESSIONS (GM-level tooling). The server owner holds every
 *         permission; a plain member with only default @everyone lacks
 *         MANAGE_SESSIONS and is rejected with 403.
 *   - missing encounter → 404, missing channel → 404, bad body → 400.
 *   - create sorts the supplied participants by initiative descending and
 *     stamps `position` 0..n-1 in that order.
 *
 * Fixtures: a server (owner) with an @everyone role whose bitset we tune
 * per-test (to grant or withhold MANAGE_SESSIONS) and one text channel.
 * Federation is off so no route touches the outbound queue.
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
 * @everyone bitset so a test can grant MANAGE_SESSIONS to every member
 * (separate from the owner shortcut).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Encounter Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'battlefield' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

interface EncounterSeedOptions {
  status?: 'setup' | 'running' | 'ended';
  currentTurnIndex?: number;
  round?: number;
  participants?: Array<{ name: string; initiative?: number; position?: number }>;
}

/**
 * Seed an encounter (+ optional participants) directly so the
 * start/next-turn/participant/end fixtures don't depend on the create route.
 */
async function makeEncounter(
  channelId: string,
  createdBy: string,
  opts: EncounterSeedOptions = {},
): Promise<{ encounterId: string; participantIds: string[] }> {
  const encounterId = ulid();
  await prisma.initiativeEncounter.create({
    data: {
      id: encounterId,
      channelId,
      createdBy,
      status: opts.status ?? 'setup',
      currentTurnIndex: opts.currentTurnIndex ?? 0,
      round: opts.round ?? 1,
      name: 'Goblin Ambush',
    },
  });
  const participantIds: string[] = [];
  const participants = opts.participants ?? [];
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i]!;
    const pid = ulid();
    participantIds.push(pid);
    await prisma.initiativeParticipant.create({
      data: {
        id: pid,
        encounterId,
        name: p.name,
        initiative: p.initiative ?? 0,
        position: p.position ?? i,
      },
    });
  }
  return { encounterId, participantIds };
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
type EncounterDto = {
  id: string;
  channelId: string;
  status: string;
  currentTurnIndex: number;
  round: number;
  participants: Array<{ id: string; name: string; initiative: number; position: number; hidden: boolean }>;
};

describe.skipIf(!dockerOk)('initiative-encounter routes (apps/api/src/routes/encounters.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.initiativeParticipant.deleteMany({});
    await prisma.initiativeEncounter.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- POST /api/channels/:id/encounters ------------------------------

  it('the server owner can create an encounter (201); participants are sorted by initiative desc', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/encounters`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Ambush',
          participants: [
            { name: 'Goblin', initiative: 8 },
            { name: 'Rogue', initiative: 20 },
            { name: 'Fighter', initiative: 14 },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<EncounterDto>;
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.status).toBe('setup');
      // Sorted by initiative descending, positions 0..n-1.
      expect(body.data.participants.map((p) => p.name)).toEqual(['Rogue', 'Fighter', 'Goblin']);
      expect(body.data.participants.map((p) => p.position)).toEqual([0, 1, 2]);

      const rows = await prisma.initiativeParticipant.findMany({
        where: { encounterId: body.data.id },
        orderBy: { position: 'asc' },
      });
      expect(rows.map((r) => r.name)).toEqual(['Rogue', 'Fighter', 'Goblin']);
    } finally {
      await app.close();
    }
  });

  it('a member WITH MANAGE_SESSIONS can create an encounter (201)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServer(ownerId, Permission.MANAGE_SESSIONS);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/encounters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Member-run fight' },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT MANAGE_SESSIONS cannot create an encounter (403), no row written', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/encounters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Should fail' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.initiativeEncounter.count({ where: { channelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('a non-member cannot create an encounter (403)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { channelId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/encounters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Trespass' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST .../encounters is 404 for an unknown channel', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${ulid()}/encounters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Nowhere' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST .../encounters is 400 when a participant body is invalid (empty name)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/encounters`,
        headers: { authorization: `Bearer ${token}` },
        payload: { participants: [{ name: '' }] }, // name min(1) → zod fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST .../encounters without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${ulid()}/encounters`,
        payload: { name: 'Anon' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/channels/:id/encounter --------------------------------

  it('returns the active (setup/running) encounter to a member who can VIEW_CHANNEL', async () => {
    const ownerId = await makeUser('owner');
    const playerId = await makeUser('player');
    const { serverId, channelId } = await makeServer(ownerId);
    await addMember(serverId, playerId);
    const { encounterId } = await makeEncounter(channelId, ownerId, {
      status: 'running',
      participants: [{ name: 'Bandit', initiative: 5 }],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(playerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/encounter`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<EncounterDto>;
      expect(body.data.id).toBe(encounterId);
      expect(body.data.status).toBe('running');
      expect(body.data.participants).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('returns ok(null) when the channel has no active encounter (ended ones do not count)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    await makeEncounter(channelId, ownerId, { status: 'ended' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/encounter`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown>;
      expect(body.data).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('GET .../encounter is 404 for a non-member (VIEW_CHANNEL guard hides existence)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { channelId } = await makeServer(ownerId);
    await makeEncounter(channelId, ownerId, { status: 'running' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/encounter`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/encounters/:id/start ---------------------------------

  it('the owner can start an encounter (200): status running, round 1, turn 0', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId } = await makeEncounter(channelId, ownerId, { status: 'setup' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/start`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<EncounterDto>;
      expect(body.data.status).toBe('running');
      expect(body.data.round).toBe(1);
      expect(body.data.currentTurnIndex).toBe(0);

      const row = await prisma.initiativeEncounter.findUniqueOrThrow({ where: { id: encounterId } });
      expect(row.status).toBe('running');
      expect(row.startedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/encounters/:id/start is 404 for an unknown encounter', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${ulid()}/start`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT MANAGE_SESSIONS cannot start an encounter (403), status unchanged', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const { encounterId } = await makeEncounter(channelId, ownerId, { status: 'setup' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/start`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.initiativeEncounter.findUniqueOrThrow({ where: { id: encounterId } });
      expect(row.status).toBe('setup');
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/encounters/:id/next-turn -----------------------------

  it('advances the turn index, wrapping to the next round at the top of the order (200)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    // 2 participants, currently on the last turn of round 1 → wraps to round 2.
    const { encounterId } = await makeEncounter(channelId, ownerId, {
      status: 'running',
      currentTurnIndex: 1,
      round: 1,
      participants: [
        { name: 'A', initiative: 10, position: 0 },
        { name: 'B', initiative: 5, position: 1 },
      ],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/next-turn`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<EncounterDto>;
      expect(body.data.currentTurnIndex).toBe(0);
      expect(body.data.round).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('next-turn is 400 when the encounter is not running', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId } = await makeEncounter(channelId, ownerId, { status: 'setup' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/next-turn`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/encounters/:id/participants --------------------------

  it('the owner can add a participant (201), appended at the next position', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId } = await makeEncounter(channelId, ownerId, {
      status: 'running',
      participants: [{ name: 'Existing', initiative: 12, position: 0 }],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/participants`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Reinforcement', initiative: 7, hp: 11, maxHp: 11 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<EncounterDto>;
      const added = body.data.participants.find((p) => p.name === 'Reinforcement');
      expect(added).toBeDefined();
      expect(added?.position).toBe(1);

      const count = await prisma.initiativeParticipant.count({ where: { encounterId } });
      expect(count).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('add participant is 400 when the body is invalid (empty name)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId } = await makeEncounter(channelId, ownerId, { status: 'running' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/participants`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/encounters/:id/participants/:pid --------------------

  it('the owner can patch a participant (200) and the change persists', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId, participantIds } = await makeEncounter(channelId, ownerId, {
      status: 'running',
      participants: [{ name: 'Ogre', initiative: 9, position: 0 }],
    });
    const pid = participantIds[0]!;

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/encounters/${encounterId}/participants/${pid}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { hp: 3, conditions: ['prone'], hidden: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<EncounterDto>;
      const patched = body.data.participants.find((p) => p.id === pid);
      expect(patched?.hidden).toBe(true);

      const row = await prisma.initiativeParticipant.findUniqueOrThrow({ where: { id: pid } });
      expect(row.hp).toBe(3);
      expect(row.hidden).toBe(true);
      expect(row.conditions).toEqual(['prone']);
    } finally {
      await app.close();
    }
  });

  it('patch participant is 404 for an unknown encounter', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/encounters/${ulid()}/participants/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { hp: 1 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/encounters/:id/participants/:pid -------------------

  it('the owner can remove a participant (200) and the row is gone', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId, participantIds } = await makeEncounter(channelId, ownerId, {
      status: 'running',
      participants: [
        { name: 'Keep', initiative: 10, position: 0 },
        { name: 'Cull', initiative: 4, position: 1 },
      ],
    });
    const pid = participantIds[1]!;

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/encounters/${encounterId}/participants/${pid}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const gone = await prisma.initiativeParticipant.findUnique({ where: { id: pid } });
      expect(gone).toBeNull();
      const remaining = await prisma.initiativeParticipant.count({ where: { encounterId } });
      expect(remaining).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/encounters/:id/end -----------------------------------

  it('the owner can end an encounter (200): status ended, endedAt stamped', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServer(ownerId);
    const { encounterId } = await makeEncounter(channelId, ownerId, { status: 'running' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/end`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<EncounterDto>;
      expect(body.data.status).toBe('ended');

      const row = await prisma.initiativeEncounter.findUniqueOrThrow({ where: { id: encounterId } });
      expect(row.status).toBe('ended');
      expect(row.endedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT MANAGE_SESSIONS cannot end an encounter (403), status unchanged', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const { encounterId } = await makeEncounter(channelId, ownerId, { status: 'running' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/encounters/${encounterId}/end`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.initiativeEncounter.findUniqueOrThrow({ where: { id: encounterId } });
      expect(row.status).toBe('running');
    } finally {
      await app.close();
    }
  });
});
