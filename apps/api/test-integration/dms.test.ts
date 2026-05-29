/**
 * Integration coverage for the DM routes (`apps/api/src/routes/dms.ts`).
 *
 * The whole DM permission model is "are you a member of this DmChannel?",
 * with an additional shared-tavern gate when *starting* a DM. Federation is
 * off (FEDERATION_ENABLED=false + no selfHost wired) so the route never
 * touches the outbound queue — every fan-out branch is skipped and we only
 * exercise the local DM behaviour.
 *
 * Endpoints covered (method + path):
 *   GET    /api/dms/candidates       — eligible-pool (shared-tavern members)
 *   GET    /api/dms                  — list my DM channels, empty + populated
 *   POST   /api/dms/direct           — open/reuse 1:1; idempotent; 403 gate
 *   POST   /api/dms/group            — create group; 403 gate; 400 too-few
 *   GET    /api/dms/:id              — fetch one; 404 non-member; 400 bad id
 *   PATCH  /api/dms/:id              — rename group; 400 on direct; 404 member
 *   POST   /api/dms/:id/read         — mark read; watermark bump; 404 member
 *   GET    /api/dms/:id/messages     — list; 404 non-member
 *   POST   /api/dms/:id/messages     — send; reply/attachment/nonce/lock cases
 *
 * Auth: every endpoint 401s without a bearer token.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { ulid } from '@tavern/shared';
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

/** Bare server with one member, used only to satisfy the shared-tavern gate. */
async function makeServer(ownerId: string): Promise<string> {
  const serverId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'DM Tavern' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return serverId;
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Direct DM channel between two users (mirrors federation-fanout-create.test.ts). */
async function makeDirectDm(userAId: string, userBId: string): Promise<string> {
  const id = ulid();
  const sorted = [userAId, userBId].sort();
  await prisma.dmChannel.create({
    data: { id, kind: 'direct', pairKey: `${sorted[0]}:${sorted[1]}`, createdById: userAId },
  });
  await prisma.dmChannelMember.create({ data: { dmChannelId: id, userId: userAId } });
  await prisma.dmChannelMember.create({ data: { dmChannelId: id, userId: userBId } });
  return id;
}

/** Group DM channel for the given members. First member is the creator. */
async function makeGroupDm(memberIds: string[], name: string | null = null): Promise<string> {
  const id = ulid();
  await prisma.dmChannel.create({
    data: { id, kind: 'group', name, createdById: memberIds[0] },
  });
  for (const userId of memberIds) {
    await prisma.dmChannelMember.create({ data: { dmChannelId: id, userId } });
  }
  return id;
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
// Well-formed ULID that does not exist in the DB — distinguishes 404 (valid
// shape, no row) from 400 (malformed shape rejected by idSchema).
const ABSENT_ID = ulid();

describe.skipIf(!dockerOk)('DM routes', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.attachment.deleteMany({});
    await prisma.dmChannelMember.deleteMany({});
    await prisma.dmChannel.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- Auth (401) --------------------------------------------------------

  it('rejects every DM endpoint with 401 when unauthenticated', async () => {
    const app = await buildTestApp();
    try {
      const calls: Array<[string, string]> = [
        ['GET', '/api/dms/candidates'],
        ['GET', '/api/dms'],
        ['POST', '/api/dms/direct'],
        ['POST', '/api/dms/group'],
        ['GET', `/api/dms/${ABSENT_ID}`],
        ['PATCH', `/api/dms/${ABSENT_ID}`],
        ['POST', `/api/dms/${ABSENT_ID}/read`],
        ['GET', `/api/dms/${ABSENT_ID}/messages`],
        ['POST', `/api/dms/${ABSENT_ID}/messages`],
      ];
      for (const [method, url] of calls) {
        const res = await app.inject({ method: method as 'GET', url, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/dms/candidates -------------------------------------------

  it('lists candidates as users who share a tavern with me (and never myself)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol'); // shares no server with alice
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/dms/candidates',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ userId: string }>>;
      const ids = body.data.map((c) => c.userId);
      expect(ids).toContain(bob);
      expect(ids).not.toContain(alice);
      expect(ids).not.toContain(carol);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/dms ------------------------------------------------------

  it('returns an empty list when I have no DM channels', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/dms',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('lists my DM channels with members and my read watermark', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/dms',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; members: unknown[] }>>;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(dmId);
      expect(body.data[0]?.members).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/dms/direct ----------------------------------------------

  it('opens a 1:1 DM with a shared-tavern member and reuses it on the second call', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const first = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: bob },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as OkBody<{ id: string; kind: string }>;
      expect(firstBody.data.kind).toBe('direct');

      const second = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: bob },
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as OkBody<{ id: string }>;
      // Idempotent: same channel id, one row in the DB.
      expect(secondBody.data.id).toBe(firstBody.data.id);
      const count = await prisma.dmChannel.count();
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('forbids opening a DM with someone I share no tavern with (403)', async () => {
    const alice = await makeUser('alice');
    const stranger = await makeUser('stranger');
    await makeServer(alice); // alice has a server; stranger is not in it

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: { userId: stranger },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.dmChannel.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects a direct-DM body missing userId (400)', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/dms/group -----------------------------------------------

  it('creates a group DM when every invitee shares a tavern with me', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);
    await addMember(serverId, carol);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/group',
        headers: { authorization: `Bearer ${token}` },
        payload: { userIds: [bob, carol], name: 'party' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; kind: string; name: string | null; members: unknown[] }>;
      expect(body.data.kind).toBe('group');
      expect(body.data.name).toBe('party');
      expect(body.data.members).toHaveLength(3); // alice + bob + carol
    } finally {
      await app.close();
    }
  });

  it('forbids a group DM that includes a non-shared-tavern user (403)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const stranger = await makeUser('stranger');
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);
    // stranger shares nothing.

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/group',
        headers: { authorization: `Bearer ${token}` },
        payload: { userIds: [bob, stranger] },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.dmChannel.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects a group DM with fewer than 2 invitees (400 schema)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/group',
        headers: { authorization: `Bearer ${token}` },
        payload: { userIds: [bob] }, // schema requires min 2
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/dms/:id --------------------------------------------------

  it('fetches a DM channel I belong to', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: `/api/dms/${dmId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(dmId);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when fetching a DM I do not belong to', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const outsider = await makeUser('outsider');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsider);
      const res = await app.inject({
        method: 'GET',
        url: `/api/dms/${dmId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      // Non-membership surfaces as 404 (avoids leaking which DMs exist).
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for a well-formed but unknown DM id', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: `/api/dms/${ABSENT_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 400 for a malformed (non-ULID) DM id', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/dms/not-a-ulid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/dms/:id ------------------------------------------------

  it('renames a group DM I belong to', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const dmId = await makeGroupDm([alice, bob, carol], 'old name');

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/dms/${dmId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'new name' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string | null }>;
      expect(body.data.name).toBe('new name');
      const row = await prisma.dmChannel.findUnique({ where: { id: dmId } });
      expect(row?.name).toBe('new name');
    } finally {
      await app.close();
    }
  });

  it('rejects renaming a direct DM with 400 (only groups carry a name)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/dms/${dmId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'nope' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when renaming a group DM I do not belong to', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const outsider = await makeUser('outsider');
    const dmId = await makeGroupDm([alice, bob, carol], 'old');

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsider);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/dms/${dmId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'hijack' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/dms/:id/read --------------------------------------------

  it('marks a DM channel as read and bumps the member watermark', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const at = '2026-05-28T00:00:00.000Z';
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/read`,
        headers: { authorization: `Bearer ${token}` },
        payload: { at },
      });
      expect(res.statusCode).toBe(200);
      const member = await prisma.dmChannelMember.findUnique({
        where: { dmChannelId_userId: { dmChannelId: dmId, userId: alice } },
      });
      expect(member?.lastReadAt?.toISOString()).toBe(at);
    } finally {
      await app.close();
    }
  });

  it('marks a DM as read with no body (server uses now())', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/read`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const member = await prisma.dmChannelMember.findUnique({
        where: { dmChannelId_userId: { dmChannelId: dmId, userId: alice } },
      });
      expect(member?.lastReadAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 404 when marking a DM I do not belong to as read', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const outsider = await makeUser('outsider');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsider);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/read`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/dms/:id/messages -----------------------------------------

  it('lists DM messages newest-first for a member', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);
    const m1 = ulid();
    const m2 = ulid();
    await prisma.message.create({
      data: { id: m1, dmChannelId: dmId, authorId: alice, type: 'default', content: 'first' },
    });
    await prisma.message.create({
      data: { id: m2, dmChannelId: dmId, authorId: bob, type: 'default', content: 'second' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string }>>;
      expect(body.data).toHaveLength(2);
      // Ordered by id desc → the lexically-larger ULID (m2) comes first.
      expect(body.data[0]?.id).toBe(m2);
      expect(body.data[1]?.id).toBe(m1);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when listing messages of a DM I do not belong to', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const outsider = await makeUser('outsider');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsider);
      const res = await app.inject({
        method: 'GET',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/dms/:id/messages ----------------------------------------

  it('posts a DM message and bumps the channel lastMessageAt', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hi bob' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; content: string }>;
      expect(body.data.content).toBe('hi bob');

      const channel = await prisma.dmChannel.findUnique({ where: { id: dmId } });
      expect(channel?.lastMessageAt).not.toBeNull();
      const stored = await prisma.message.findUnique({ where: { id: body.data.id } });
      expect(stored?.authorId).toBe(alice);
    } finally {
      await app.close();
    }
  });

  it('strips HTML from DM message content on send', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: '<script>alert(1)</script>hello' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ content: string }>;
      expect(body.data.content).not.toContain('<script>');
      expect(body.data.content).toContain('hello');
    } finally {
      await app.close();
    }
  });

  it('replays the same nonce idempotently for the same author (200, no duplicate)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const post = () =>
        app.inject({
          method: 'POST',
          url: `/api/dms/${dmId}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: { content: 'once', nonce: 'DM-NONCE' },
        });
      const first = await post();
      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as OkBody<{ id: string }>;

      const second = await post();
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as OkBody<{ id: string }>;
      expect(secondBody.data.id).toBe(firstBody.data.id);

      const count = await prisma.message.count({ where: { dmChannelId: dmId, nonce: 'DM-NONCE' } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a different author reusing another member's nonce (400, no leak)", async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const aliceToken = await mintToken(alice);
      const bobToken = await mintToken(bob);

      const aliceRes = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${aliceToken}` },
        payload: { content: 'alice secret', nonce: 'SHARED' },
      });
      expect(aliceRes.statusCode).toBe(201);

      const bobRes = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { content: 'bob attempt', nonce: 'SHARED' },
      });
      expect(bobRes.statusCode).toBe(400);
      expect(bobRes.body).not.toContain('alice secret');
    } finally {
      await app.close();
    }
  });

  it('rejects a reply whose target is in another channel (400)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const dmId = await makeDirectDm(alice, bob);
    const otherDmId = await makeDirectDm(alice, carol);
    // A message that lives in the *other* DM channel.
    const foreignMessageId = ulid();
    await prisma.message.create({
      data: { id: foreignMessageId, dmChannelId: otherDmId, authorId: alice, type: 'default', content: 'elsewhere' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'reply', replyToMessageId: foreignMessageId },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown attachment id (400)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'with file', attachmentIds: [ulid()] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("forbids attaching another user's upload (403)", async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);
    // An attachment owned by bob, ready to send.
    const attId = ulid();
    await prisma.attachment.create({
      data: {
        id: attId,
        uploaderId: bob,
        kind: 'image',
        status: 'ready',
        filename: 'f.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        storageBucket: 'media',
        storageKey: `k/${attId}`,
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'steal', attachmentIds: [attId] },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('attaches my own ready upload and links it to the message', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);
    const attId = ulid();
    await prisma.attachment.create({
      data: {
        id: attId,
        uploaderId: alice,
        kind: 'image',
        status: 'ready',
        filename: 'f.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        storageBucket: 'media',
        storageKey: `k/${attId}`,
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'here', attachmentIds: [attId] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const linked = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(linked?.messageId).toBe(body.data.id);
    } finally {
      await app.close();
    }
  });

  it('forbids posting while the user is posting-locked (403 CONTENT_HELD)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const dmId = await makeDirectDm(alice, bob);
    await prisma.user.update({
      where: { id: alice },
      data: { postingLockedUntil: new Date(Date.now() + 60_000) },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'blocked' },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.message.count({ where: { dmChannelId: dmId } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when posting a message to a DM I do not belong to', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const outsider = await makeUser('outsider');
    const dmId = await makeDirectDm(alice, bob);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsider);
      const res = await app.inject({
        method: 'POST',
        url: `/api/dms/${dmId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'intrude' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
