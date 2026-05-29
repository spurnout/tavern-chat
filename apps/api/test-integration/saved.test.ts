/**
 * Integration coverage for the personal saved-messages (bookmarks) surface in
 * `apps/api/src/routes/saved.ts`, exercised end-to-end against a real Postgres
 * testcontainer via `app.inject`.
 *
 * Routes covered:
 *   POST   /api/me/saved/:messageId — save (bookmark) a message
 *   GET    /api/me/saved            — list saved messages (paginated)
 *   DELETE /api/me/saved/:messageId — unsave a message
 *
 * Auth + permission model:
 *   - All routes require a valid Bearer token (401 without).
 *   - Saving a server message requires the caller to be a member of the server
 *     that owns the channel; otherwise 403.
 *   - Saving a DM message requires the caller to be a member of the DmChannel;
 *     otherwise 403.
 *   - Saving a nonexistent or soft-deleted message returns 404.
 *   - Saving is idempotent (upsert): a second save of the same message updates
 *     the note and still returns 201.
 *   - Unsaving a message that was never saved returns 404.
 *   - Saved state is private per user — user B cannot see user A's bookmarks.
 *
 * Federation is off so no route touches the outbound queue.
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
  channelId: string;
}

async function makeServerWithChannel(ownerId: string): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Saved Tavern' } });
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

/** Create a server message in the given channel, authored by authorId. */
async function makeMessage(channelId: string, serverId: string, authorId: string): Promise<string> {
  const id = ulid();
  await prisma.message.create({
    data: {
      id,
      channelId,
      serverId,
      authorId,
      content: `message-${id.slice(-6)}`,
    },
  });
  return id;
}

/** Create a soft-deleted server message. */
async function makeDeletedMessage(
  channelId: string,
  serverId: string,
  authorId: string,
): Promise<string> {
  const id = ulid();
  await prisma.message.create({
    data: {
      id,
      channelId,
      serverId,
      authorId,
      content: 'deleted',
      deletedAt: new Date(),
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
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('saved-message routes (apps/api/src/routes/saved.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // -------------------------------------------------------------------------
  // POST /api/me/saved/:messageId
  // -------------------------------------------------------------------------

  it('POST /api/me/saved/:messageId — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — 404 for an unknown message', async () => {
    const userId = await makeUser('u');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — 404 for a soft-deleted message', async () => {
    const userId = await makeUser('u');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const messageId = await makeDeletedMessage(channelId, serverId, userId);
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — 403 when caller is not a member of the server', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    // outsiderId is NOT added as a server member.
    const messageId = await makeMessage(channelId, serverId, ownerId);
    const token = await mintToken(outsiderId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — 201 saves a server message for a member', async () => {
    const userId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const messageId = await makeMessage(channelId, serverId, userId);
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { note: 'remember this' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        messageId: string;
        savedAt: string;
        note: string | null;
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.messageId).toBe(messageId);
      expect(body.data.note).toBe('remember this');
      expect(typeof body.data.savedAt).toBe('string');

      // Row must exist in DB.
      const row = await prisma.savedMessage.findUnique({
        where: { userId_messageId: { userId, messageId } },
      });
      expect(row).not.toBeNull();
      expect(row?.note).toBe('remember this');
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — idempotent: second save updates note, still 201', async () => {
    const userId = await makeUser('idempotent');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const messageId = await makeMessage(channelId, serverId, userId);
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      // First save.
      const first = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { note: 'original' },
      });
      expect(first.statusCode).toBe(201);

      // Second save with a different note — upsert path.
      const second = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { note: 'updated' },
      });
      expect(second.statusCode).toBe(201);
      const body = second.json() as OkBody<{ messageId: string; note: string | null }>;
      expect(body.data.messageId).toBe(messageId);
      expect(body.data.note).toBe('updated');

      // Exactly one row (upsert, not insert).
      const count = await prisma.savedMessage.count({ where: { userId, messageId } });
      expect(count).toBe(1);

      // Note is updated.
      const row = await prisma.savedMessage.findUniqueOrThrow({
        where: { userId_messageId: { userId, messageId } },
      });
      expect(row.note).toBe('updated');
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — note is optional (no note field in body)', async () => {
    const userId = await makeUser('nonote');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const messageId = await makeMessage(channelId, serverId, userId);
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ note: string | null }>;
      expect(body.data.note).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — 403 when caller is not a DmChannel member', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const outsiderId = await makeUser('outsider');

    // Create a DM channel between alice and bob.
    const dmId = ulid();
    await prisma.dmChannel.create({ data: { id: dmId, kind: 'direct' } });
    await prisma.dmChannelMember.create({ data: { dmChannelId: dmId, userId: aliceId } });
    await prisma.dmChannelMember.create({ data: { dmChannelId: dmId, userId: bobId } });

    // Post a message from alice in the DM.
    const msgId = ulid();
    await prisma.message.create({
      data: {
        id: msgId,
        dmChannelId: dmId,
        authorId: aliceId,
        content: 'hello dm',
      },
    });

    const token = await mintToken(outsiderId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/saved/:messageId — 201 for a DM message when the caller is a member', async () => {
    const aliceId = await makeUser('alicedm');
    const bobId = await makeUser('bobdm');

    const dmId = ulid();
    await prisma.dmChannel.create({ data: { id: dmId, kind: 'direct' } });
    await prisma.dmChannelMember.create({ data: { dmChannelId: dmId, userId: aliceId } });
    await prisma.dmChannelMember.create({ data: { dmChannelId: dmId, userId: bobId } });

    const msgId = ulid();
    await prisma.message.create({
      data: {
        id: msgId,
        dmChannelId: dmId,
        authorId: aliceId,
        content: 'dm msg',
      },
    });

    const token = await mintToken(bobId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/saved/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ messageId: string }>;
      expect(body.data.messageId).toBe(msgId);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/me/saved
  // -------------------------------------------------------------------------

  it('GET /api/me/saved — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/saved' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/saved — returns empty list for a user with no saves', async () => {
    const userId = await makeUser('emptylist');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/saved',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ items: unknown[]; nextCursor: string | null }>;
      expect(body.ok).toBe(true);
      expect(body.data.items).toEqual([]);
      expect(body.data.nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/saved — lists saved messages owned by the caller (excludes other users saves)', async () => {
    const aliceId = await makeUser('alice2');
    const bobId = await makeUser('bob2');
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);

    const msg1 = await makeMessage(channelId, serverId, aliceId);
    const msg2 = await makeMessage(channelId, serverId, aliceId);

    // Alice saves msg1, Bob saves msg2.
    await prisma.savedMessage.create({ data: { userId: aliceId, messageId: msg1 } });
    await prisma.savedMessage.create({ data: { userId: bobId, messageId: msg2 } });

    const aliceToken = await mintToken(aliceId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/saved',
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ items: Array<{ messageId: string }> }>;
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]?.messageId).toBe(msg1);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/saved — returns savedAt, note, and inline message data', async () => {
    const userId = await makeUser('withdata');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const msgId = await makeMessage(channelId, serverId, userId);
    await prisma.savedMessage.create({
      data: { userId, messageId: msgId, note: 'my note' },
    });

    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/saved',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        items: Array<{
          messageId: string;
          savedAt: string;
          note: string | null;
          message: { id: string };
        }>;
        nextCursor: string | null;
      }>;
      const item = body.data.items[0];
      expect(item).toBeDefined();
      expect(item!.messageId).toBe(msgId);
      expect(item!.note).toBe('my note');
      expect(typeof item!.savedAt).toBe('string');
      expect(item!.message.id).toBe(msgId);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/saved — pagination: limit + nextCursor', async () => {
    const userId = await makeUser('paginat');
    const { serverId, channelId } = await makeServerWithChannel(userId);

    // Create 3 messages and save them all.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await makeMessage(channelId, serverId, userId));
    }
    for (const msgId of ids) {
      await prisma.savedMessage.create({ data: { userId, messageId: msgId } });
    }

    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      // Fetch with limit=2 — should get first 2 and a cursor.
      const firstPage = await app.inject({
        method: 'GET',
        url: '/api/me/saved?limit=2',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json() as OkBody<{
        items: Array<{ messageId: string }>;
        nextCursor: string | null;
      }>;
      expect(firstBody.data.items).toHaveLength(2);
      expect(firstBody.data.nextCursor).not.toBeNull();

      // Fetch next page using the cursor.
      const secondPage = await app.inject({
        method: 'GET',
        url: `/api/me/saved?limit=2&cursor=${firstBody.data.nextCursor}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(secondPage.statusCode).toBe(200);
      const secondBody = secondPage.json() as OkBody<{
        items: Array<{ messageId: string }>;
        nextCursor: string | null;
      }>;
      expect(secondBody.data.items).toHaveLength(1);
      expect(secondBody.data.nextCursor).toBeNull();

      // No duplicates across pages.
      const allIds = [
        ...firstBody.data.items.map((i) => i.messageId),
        ...secondBody.data.items.map((i) => i.messageId),
      ];
      expect(new Set(allIds).size).toBe(3);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/me/saved/:messageId
  // -------------------------------------------------------------------------

  it('DELETE /api/me/saved/:messageId — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/saved/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/saved/:messageId — 404 when the message was never saved', async () => {
    const userId = await makeUser('nodelsave');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/saved/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/saved/:messageId — 200 removes the bookmark row', async () => {
    const userId = await makeUser('deletesave');
    const { serverId, channelId } = await makeServerWithChannel(userId);
    const msgId = await makeMessage(channelId, serverId, userId);
    await prisma.savedMessage.create({ data: { userId, messageId: msgId } });
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/saved/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ messageId: string }>;
      expect(body.ok).toBe(true);
      expect(body.data.messageId).toBe(msgId);

      // Row must be gone.
      const row = await prisma.savedMessage.findUnique({
        where: { userId_messageId: { userId, messageId: msgId } },
      });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/saved/:messageId — user B cannot delete user A bookmark (404 — row not found for B)', async () => {
    const aliceId = await makeUser('alice3');
    const bobId = await makeUser('bob3');
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    const msgId = await makeMessage(channelId, serverId, aliceId);
    // Only alice saves the message.
    await prisma.savedMessage.create({ data: { userId: aliceId, messageId: msgId } });

    const bobToken = await mintToken(bobId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/saved/${msgId}`,
        headers: { authorization: `Bearer ${bobToken}` },
      });
      // Bob has no save for this message — 404.
      expect(res.statusCode).toBe(404);

      // Alice's row must be untouched.
      const row = await prisma.savedMessage.findUnique({
        where: { userId_messageId: { userId: aliceId, messageId: msgId } },
      });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
