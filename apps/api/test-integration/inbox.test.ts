/**
 * Integration coverage for the activity-inbox / unread-state routes
 * (`apps/api/src/routes/inbox.ts`).
 *
 * Unread model: a single read cursor per (user, channel) in
 * UserChannelReadState; messages with id > lastReadMessageId are unread. The
 * activity inbox is the list of UserMention rows; `isRead=false` is the
 * default filter. We seed Message + UserMention + UserChannelReadState rows
 * directly via Prisma to exercise the read/ack paths.
 *
 * Endpoints covered (method + path):
 *   POST /api/channels/:id/ack       — set cursor, clear channel mentions
 *   GET  /api/me/read-states         — list my per-channel read state
 *   GET  /api/me/inbox               — list mentions (unread default / all)
 *   POST /api/me/inbox/:id/ack       — ack one mention; 404 not-found/not-mine
 *   POST /api/me/inbox/ack-all       — ack everything
 *
 * Auth: every endpoint 401s without a bearer token. The ack endpoint also
 * enforces VIEW_CHANNEL (non-member → 404, since VIEW_CHANNEL is masked to
 * not-found to avoid leaking channel existence).
 *
 * Federation is off so the route never touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
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

/** Server with an @everyone role (default perms include VIEW_CHANNEL) + a text channel. */
async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Inbox Tavern' } });
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
  return { serverId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Insert a message in a channel and return its id. */
async function makeMessage(channelId: string, serverId: string, authorId: string, content = 'hi'): Promise<string> {
  const id = ulid();
  await prisma.message.create({
    data: { id, channelId, serverId, authorId, type: 'default', content },
  });
  return id;
}

/** Insert an (unread) user-mention row tied to a message and return its id. */
async function makeMention(opts: {
  userId: string;
  messageId: string;
  channelId: string;
  isRead?: boolean;
}): Promise<string> {
  const id = ulid();
  await prisma.userMention.create({
    data: {
      id,
      userId: opts.userId,
      messageId: opts.messageId,
      channelId: opts.channelId,
      kind: 'user',
      isRead: opts.isRead ?? false,
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
const ABSENT_ID = ulid();

describe.skipIf(!dockerOk)('Inbox + read-state routes', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.userMention.deleteMany({});
    await prisma.userChannelReadState.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- Auth (401) --------------------------------------------------------

  it('rejects every inbox endpoint with 401 when unauthenticated', async () => {
    const app = await buildTestApp();
    try {
      const calls: Array<[string, string, unknown]> = [
        ['POST', `/api/channels/${ABSENT_ID}/ack`, { lastReadMessageId: ulid() }],
        ['GET', '/api/me/read-states', undefined],
        ['GET', '/api/me/inbox', undefined],
        ['POST', `/api/me/inbox/${ABSENT_ID}/ack`, {}],
        ['POST', '/api/me/inbox/ack-all', {}],
      ];
      for (const [method, url, payload] of calls) {
        const res = await app.inject({ method: method as 'GET', url, payload });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/channels/:id/ack ----------------------------------------

  it('acks a channel: upserts the read cursor and clears that channel\'s unread mentions', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const messageId = await makeMessage(channelId, serverId, alice);
    await makeMention({ userId: alice, messageId, channelId, isRead: false });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: { lastReadMessageId: messageId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ channelId: string; lastReadMessageId: string; mentionCount: number }>;
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.lastReadMessageId).toBe(messageId);
      expect(body.data.mentionCount).toBe(0);

      // Cursor persisted and the channel's mentions are now read.
      const state = await prisma.userChannelReadState.findUnique({
        where: { userId_channelId: { userId: alice, channelId } },
      });
      expect(state?.lastReadMessageId).toBe(messageId);
      const unread = await prisma.userMention.count({ where: { userId: alice, channelId, isRead: false } });
      expect(unread).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('acks a channel idempotently: a second ack updates the existing cursor row', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const m1 = await makeMessage(channelId, serverId, alice, 'one');
    const m2 = await makeMessage(channelId, serverId, alice, 'two');

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const ack = (lastReadMessageId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/ack`,
          headers: { authorization: `Bearer ${token}` },
          payload: { lastReadMessageId },
        });
      expect((await ack(m1)).statusCode).toBe(200);
      expect((await ack(m2)).statusCode).toBe(200);
      // Still a single read-state row, now pointing at the later message.
      const rows = await prisma.userChannelReadState.findMany({ where: { userId: alice, channelId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lastReadMessageId).toBe(m2);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when acking a channel the caller cannot view (non-member)', async () => {
    const owner = await makeUser('owner');
    const outsider = await makeUser('outsider');
    const { serverId, channelId } = await makeServerWithChannel(owner);
    const messageId = await makeMessage(channelId, serverId, owner);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsider);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: { lastReadMessageId: messageId },
      });
      // VIEW_CHANNEL failure is masked to 404 (existence-leak guard).
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when acking an unknown channel id', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${ABSENT_ID}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: { lastReadMessageId: ulid() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 400 when acking with a missing lastReadMessageId', async () => {
    const alice = await makeUser('alice');
    const { channelId } = await makeServerWithChannel(alice);
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 400 when acking with a malformed (non-ULID) channel id', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/channels/not-a-ulid/ack',
        headers: { authorization: `Bearer ${token}` },
        payload: { lastReadMessageId: ulid() },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/me/read-states -------------------------------------------

  it('returns an empty read-state list for a user who has never read anything', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/read-states',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('lists my per-channel read states after acking', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const messageId = await makeMessage(channelId, serverId, alice);

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: { lastReadMessageId: messageId },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/read-states',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ channelId: string; lastReadMessageId: string; mentionCount: number }>>;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.channelId).toBe(channelId);
      expect(body.data[0]?.lastReadMessageId).toBe(messageId);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/me/inbox -------------------------------------------------

  it('lists only unread mentions by default and switches to all with filter=all', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const m1 = await makeMessage(channelId, serverId, alice, 'unread one');
    const m2 = await makeMessage(channelId, serverId, alice, 'read one');
    const unreadMention = await makeMention({ userId: alice, messageId: m1, channelId, isRead: false });
    await makeMention({ userId: alice, messageId: m2, channelId, isRead: true });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);

      const unreadRes = await app.inject({
        method: 'GET',
        url: '/api/me/inbox',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(unreadRes.statusCode).toBe(200);
      const unreadBody = unreadRes.json() as OkBody<{ items: Array<{ id: string; isRead: boolean }> }>;
      expect(unreadBody.data.items).toHaveLength(1);
      expect(unreadBody.data.items[0]?.id).toBe(unreadMention);
      expect(unreadBody.data.items[0]?.isRead).toBe(false);

      const allRes = await app.inject({
        method: 'GET',
        url: '/api/me/inbox?filter=all',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(allRes.statusCode).toBe(200);
      const allBody = allRes.json() as OkBody<{ items: unknown[] }>;
      expect(allBody.data.items).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('paginates the inbox via limit + nextCursor', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    // Three unread mentions; ids sort by creation order (ULID).
    const mentionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const messageId = await makeMessage(channelId, serverId, alice, `m${i}`);
      mentionIds.push(await makeMention({ userId: alice, messageId, channelId, isRead: false }));
    }

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const page1 = await app.inject({
        method: 'GET',
        url: '/api/me/inbox?limit=2',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json() as OkBody<{ items: Array<{ id: string }>; nextCursor: string | null }>;
      expect(body1.data.items).toHaveLength(2);
      expect(body1.data.nextCursor).not.toBeNull();

      const page2 = await app.inject({
        method: 'GET',
        url: `/api/me/inbox?limit=2&cursor=${body1.data.nextCursor}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(page2.statusCode).toBe(200);
      const body2 = page2.json() as OkBody<{ items: Array<{ id: string }>; nextCursor: string | null }>;
      expect(body2.data.items).toHaveLength(1);
      // Last page → no further cursor.
      expect(body2.data.nextCursor).toBeNull();

      // Every mention surfaced exactly once across the two pages.
      const seen = [...body1.data.items, ...body2.data.items].map((m) => m.id).sort();
      expect(seen).toEqual([...mentionIds].sort());
    } finally {
      await app.close();
    }
  });

  it('rejects an inbox limit above the schema max (400)', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/inbox?limit=500',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('scopes the inbox to the caller (never another user\'s mentions)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    await addMember(serverId, bob);
    const messageId = await makeMessage(channelId, serverId, alice);
    await makeMention({ userId: bob, messageId, channelId, isRead: false });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/inbox',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ items: unknown[] }>;
      // Alice has no mentions; bob's mention must not leak.
      expect(body.data.items).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/me/inbox/:id/ack ----------------------------------------

  it('acks a single mention and decrements the cached channel mentionCount', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const messageId = await makeMessage(channelId, serverId, alice);
    const mentionId = await makeMention({ userId: alice, messageId, channelId, isRead: false });
    // Seed a read-state row with a positive mentionCount so the decrement path runs.
    await prisma.userChannelReadState.create({
      data: { userId: alice, channelId, lastReadMessageId: null, mentionCount: 2 },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/inbox/${mentionId}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; isRead: boolean }>;
      expect(body.data.isRead).toBe(true);

      const mention = await prisma.userMention.findUnique({ where: { id: mentionId } });
      expect(mention?.isRead).toBe(true);
      const state = await prisma.userChannelReadState.findUnique({
        where: { userId_channelId: { userId: alice, channelId } },
      });
      expect(state?.mentionCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('short-circuits acking an already-read mention (200, no change)', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const messageId = await makeMessage(channelId, serverId, alice);
    const mentionId = await makeMention({ userId: alice, messageId, channelId, isRead: true });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/inbox/${mentionId}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; isRead: boolean }>;
      expect(body.data.isRead).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 404 acking an unknown mention id', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/inbox/${ABSENT_ID}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 404 acking another user's mention", async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    await addMember(serverId, bob);
    const messageId = await makeMessage(channelId, serverId, alice);
    const bobMention = await makeMention({ userId: bob, messageId, channelId, isRead: false });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/inbox/${bobMention}/ack`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      // Ownership check masks foreign mentions as not-found.
      expect(res.statusCode).toBe(404);
      // Bob's mention is untouched.
      const mention = await prisma.userMention.findUnique({ where: { id: bobMention } });
      expect(mention?.isRead).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns 400 acking a mention with a malformed (non-ULID) id', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/inbox/not-a-ulid/ack',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/me/inbox/ack-all ----------------------------------------

  it('acks all unread mentions and zeroes every cached mentionCount', async () => {
    const alice = await makeUser('alice');
    const { serverId, channelId } = await makeServerWithChannel(alice);
    const m1 = await makeMessage(channelId, serverId, alice, 'a');
    const m2 = await makeMessage(channelId, serverId, alice, 'b');
    await makeMention({ userId: alice, messageId: m1, channelId, isRead: false });
    await makeMention({ userId: alice, messageId: m2, channelId, isRead: false });
    await prisma.userChannelReadState.create({
      data: { userId: alice, channelId, lastReadMessageId: null, mentionCount: 2 },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/inbox/ack-all',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);

      const unread = await prisma.userMention.count({ where: { userId: alice, isRead: false } });
      expect(unread).toBe(0);
      const state = await prisma.userChannelReadState.findUnique({
        where: { userId_channelId: { userId: alice, channelId } },
      });
      expect(state?.mentionCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('ack-all is a no-op (still 200) when there is nothing unread', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/inbox/ack-all',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});
