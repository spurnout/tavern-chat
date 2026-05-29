/**
 * Integration coverage for message edit / delete / forward / list + pagination
 * paths in `apps/api/src/routes/messages.ts`.
 *
 * The nonce-idempotency / create path is covered by nonce-idempotency.test.ts.
 * This file focuses on:
 *
 *   GET    /api/channels/:id/messages  — list, pagination (before/after cursor),
 *                                        READ_MESSAGE_HISTORY permission, 401
 *   PATCH  /api/messages/:id           — edit (200), author guard (403),
 *                                        missing message (404), invalid body (400),
 *                                        edit history written, no-op same-content,
 *                                        401
 *   DELETE /api/messages/:id           — author delete (200), MANAGE_MESSAGES
 *                                        moderator delete (200), non-author
 *                                        without MANAGE_MESSAGES (403), missing
 *                                        (404), already-deleted (404), 401
 *   POST   /api/channels/:id/messages  — forward (201), forward missing source
 *                                        (400), forward deleted source (400)
 *
 * Federation is off for all tests.
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

interface ServerFixture {
  serverId: string;
  everyoneRoleId: string;
  channelId: string;
}

/**
 * Server owned by `ownerId` with an @everyone role + one text channel.
 * `extraPerms` is OR-ed onto the default @everyone bitset so callers can grant
 * MANAGE_MESSAGES or other bits without changing the base fixture.
 */
async function makeServerWithChannel(
  ownerId: string,
  extraPerms = 0n,
): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Messages Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE | extraPerms),
      ),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: { id: channelId, serverId, type: 'text', name: 'general' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneRoleId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: { id: ulid(), userId, label: 'test', tokenHash: hash },
  });
  return raw;
}

/**
 * Insert a message directly via Prisma (bypasses the route), useful for
 * seeding messages with known IDs for PATCH/DELETE tests without relying on
 * the POST route's nonce/validation path.
 */
async function seedMessage(
  channelId: string,
  serverId: string,
  authorId: string,
  content = 'original content',
): Promise<string> {
  const id = ulid();
  await prisma.message.create({
    data: {
      id,
      serverId,
      channelId,
      authorId,
      type: 'default',
      content,
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
// beforeEach: FK-safe teardown (children first, then parents)
// ---------------------------------------------------------------------------

beforeEach(async () => {
  if (!dockerOk) return;
  await prisma.apiToken.deleteMany({});
  await prisma.messageEdit.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.userMention.deleteMany({});
  await prisma.pinnedMessage.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
});

// ===========================================================================
// GET /api/channels/:id/messages
// ===========================================================================

describe.skipIf(!dockerOk)(
  'GET /api/channels/:id/messages — list + pagination',
  () => {
    it('returns messages (200, newest-first) for a member with READ_MESSAGE_HISTORY', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      // Seed three messages with known ordering via direct inserts.
      const msgId1 = await seedMessage(channelId, serverId, ownerId, 'first');
      const msgId2 = await seedMessage(channelId, serverId, ownerId, 'second');
      const msgId3 = await seedMessage(channelId, serverId, ownerId, 'third');

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string; content: string }>>;
        // Response array includes all three seeded messages.
        const ids = body.data.map((m) => m.id);
        expect(ids).toContain(msgId1);
        expect(ids).toContain(msgId2);
        expect(ids).toContain(msgId3);
        // Newest-first ordering (msgId3 > msgId2 > msgId1 because ULIDs are
        // time-ordered and were created sequentially).
        const idxFirst = ids.indexOf(msgId1);
        const idxThird = ids.indexOf(msgId3);
        expect(idxThird).toBeLessThan(idxFirst);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when no bearer token is provided', async () => {
      const ownerId = await makeUser('owner');
      const { channelId } = await makeServerWithChannel(ownerId);
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when the member lacks READ_MESSAGE_HISTORY (channel deny overwrite)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, everyoneRoleId, channelId } =
        await makeServerWithChannel(ownerId);
      await addMember(serverId, memberId);
      // Deny READ_MESSAGE_HISTORY on the channel for @everyone.
      await prisma.permissionOverwrite.create({
        data: {
          id: ulid(),
          channelId,
          targetType: 'role',
          targetId: everyoneRoleId,
          deny: new Prisma.Decimal(serializePermissions(Permission.READ_MESSAGE_HISTORY)),
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('cursor pagination with `before` returns messages older than the cursor', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      // Seed 5 messages.
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seedMessage(channelId, serverId, ownerId, `msg ${i}`));
      }
      // The list returns newest-first; ids[4] is newest, ids[0] is oldest.
      // Use ids[3] as the `before` cursor — expect to see ids[0..2] (older).
      const cursor = ids[3]!;

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages?before=${cursor}&limit=10`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string }>>;
        const returnedIds = body.data.map((m) => m.id);
        // cursor itself must not appear
        expect(returnedIds).not.toContain(cursor);
        // ids[4] (newer than cursor) must not appear
        expect(returnedIds).not.toContain(ids[4]);
        // older ones are present
        expect(returnedIds).toContain(ids[0]);
        expect(returnedIds).toContain(ids[1]);
        expect(returnedIds).toContain(ids[2]);
      } finally {
        await app.close();
      }
    });

    it('cursor pagination with `after` returns messages newer than the cursor, newest-first in response', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seedMessage(channelId, serverId, ownerId, `msg ${i}`));
      }
      // ids[0] is oldest. Use it as `after` cursor — expect ids[1..4].
      const cursor = ids[0]!;

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages?after=${cursor}&limit=10`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string }>>;
        const returnedIds = body.data.map((m) => m.id);
        expect(returnedIds).not.toContain(cursor);
        expect(returnedIds).toContain(ids[1]);
        expect(returnedIds).toContain(ids[4]);
        // Response must be newest-first (route reverses asc-sorted slice).
        const idx1 = returnedIds.indexOf(ids[1]!);
        const idx4 = returnedIds.indexOf(ids[4]!);
        expect(idx4).toBeLessThan(idx1);
      } finally {
        await app.close();
      }
    });

    it('respects the `limit` query param — returns at most `limit` messages', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      for (let i = 0; i < 10; i++) {
        await seedMessage(channelId, serverId, ownerId, `msg ${i}`);
      }

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages?limit=3`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string }>>;
        expect(body.data.length).toBeLessThanOrEqual(3);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when `limit` is out of range (> 100)', async () => {
      const ownerId = await makeUser('owner');
      const { channelId } = await makeServerWithChannel(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages?limit=200`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('deleted messages are excluded from the list', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      const liveId = await seedMessage(channelId, serverId, ownerId, 'live');
      const deadId = await seedMessage(channelId, serverId, ownerId, 'dead');
      // Soft-delete the second message directly.
      await prisma.message.update({
        where: { id: deadId },
        data: { deletedAt: new Date(), content: '' },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<Array<{ id: string }>>;
        const ids = body.data.map((m) => m.id);
        expect(ids).toContain(liveId);
        expect(ids).not.toContain(deadId);
      } finally {
        await app.close();
      }
    });

    it('response messages carry the correct { ok:true, data:[] } envelope and message shape', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      await seedMessage(channelId, serverId, ownerId, 'hello');

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<
          Array<{
            id: string;
            content: string;
            authorId: string;
            channelId: string | null;
            createdAt: string;
          }>
        >;
        expect(body.ok).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        const msg = body.data[0]!;
        expect(msg).toHaveProperty('id');
        expect(msg).toHaveProperty('content', 'hello');
        expect(msg).toHaveProperty('authorId', ownerId);
        expect(msg).toHaveProperty('channelId', channelId);
        expect(msg).toHaveProperty('createdAt');
      } finally {
        await app.close();
      }
    });
  },
);

// ===========================================================================
// PATCH /api/messages/:id — edit
// ===========================================================================

describe.skipIf(!dockerOk)('PATCH /api/messages/:id — edit', () => {
  it('author can edit their own message (200), content updated in DB', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'before edit');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'after edit' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; content: string; editedAt: string | null }>;
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(msgId);
      expect(body.data.content).toBe('after edit');
      expect(body.data.editedAt).not.toBeNull();

      const row = await prisma.message.findUniqueOrThrow({ where: { id: msgId } });
      expect(row.content).toBe('after edit');
      expect(row.editedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('edit writes the previous content to MessageEdit history', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'original');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'revised' },
      });
      const edits = await prisma.messageEdit.findMany({ where: { messageId: msgId } });
      expect(edits.length).toBe(1);
      expect(edits[0]!.content).toBe('original');
      expect(edits[0]!.editedBy).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('editing to the same content does NOT write a MessageEdit history entry', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'same');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'same' },
      });
      const edits = await prisma.messageEdit.findMany({ where: { messageId: msgId } });
      // No history entry when content is unchanged.
      expect(edits.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('a non-author member cannot edit the message (403)', async () => {
    const ownerId = await makeUser('author');
    const otherUserId = await makeUser('other');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, otherUserId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'locked');

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherUserId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.message.findUniqueOrThrow({ where: { id: msgId } });
      expect(row.content).toBe('locked');
    } finally {
      await app.close();
    }
  });

  it('editing a non-existent message returns 404', async () => {
    const ownerId = await makeUser('author');
    await makeServerWithChannel(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('editing a soft-deleted message returns 404', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'deleted');
    await prisma.message.update({
      where: { id: msgId },
      data: { deletedAt: new Date(), content: '' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'resurrection' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH without a token returns 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${ulid()}`,
        payload: { content: 'anon edit' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('PATCH with an empty body (missing content field) returns 400', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'valid');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // missing `content`
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('MANAGE_MESSAGES holder cannot edit someone else\'s message (403 — edit is author-only)', async () => {
    const ownerId = await makeUser('author');
    const modId = await makeUser('mod');
    // Grant MANAGE_MESSAGES to @everyone so the mod has it.
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    await addMember(serverId, modId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'author only');

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'mod edit attempt' },
      });
      // Edit is strictly author-only regardless of MANAGE_MESSAGES.
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

// ===========================================================================
// DELETE /api/messages/:id
// ===========================================================================

describe.skipIf(!dockerOk)('DELETE /api/messages/:id — delete', () => {
  it('author can delete their own message (200), soft-deleted in DB', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'bye bye');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(msgId);

      const row = await prisma.message.findUniqueOrThrow({ where: { id: msgId } });
      expect(row.deletedAt).not.toBeNull();
      // Content is blanked on soft-delete.
      expect(row.content).toBe('');
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_MESSAGES can delete another user\'s message (200)', async () => {
    const ownerId = await makeUser('author');
    const modId = await makeUser('mod');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    await addMember(serverId, modId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'removable');

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.message.findUniqueOrThrow({ where: { id: msgId } });
      expect(row.deletedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a moderator delete writes an audit entry', async () => {
    const ownerId = await makeUser('author');
    const modId = await makeUser('mod');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    await addMember(serverId, modId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'audited');

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      await app.inject({
        method: 'DELETE',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const entry = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'message.deleted', targetId: msgId },
      });
      expect(entry).not.toBeNull();
      expect(entry!.actorId).toBe(modId);
    } finally {
      await app.close();
    }
  });

  it('a non-author member without MANAGE_MESSAGES cannot delete (403)', async () => {
    const ownerId = await makeUser('author');
    const randoId = await makeUser('rando');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, randoId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'safe');

    const app = await buildTestApp();
    try {
      const token = await mintToken(randoId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.message.findUniqueOrThrow({ where: { id: msgId } });
      expect(row.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('deleting a non-existent message returns 404', async () => {
    const ownerId = await makeUser('author');
    await makeServerWithChannel(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('deleting an already-deleted message returns 404', async () => {
    const ownerId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'already gone');
    await prisma.message.update({
      where: { id: msgId },
      data: { deletedAt: new Date(), content: '' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE without a token returns 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('delete cleans up reactions and pins associated with the message', async () => {
    const ownerId = await makeUser('author');
    const reactorId = await makeUser('reactor');
    const modId = await makeUser('mod');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    await addMember(serverId, reactorId);
    await addMember(serverId, modId);
    const msgId = await seedMessage(channelId, serverId, ownerId, 'has reactions');
    // Seed a reaction and a pin manually.
    await prisma.messageReaction.create({
      data: { messageId: msgId, userId: reactorId, emoji: '👍' },
    });
    await prisma.pinnedMessage.create({
      data: { messageId: msgId, channelId, pinnedBy: modId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      await app.inject({
        method: 'DELETE',
        url: `/api/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const reactions = await prisma.messageReaction.findMany({
        where: { messageId: msgId },
      });
      expect(reactions).toHaveLength(0);
      const pins = await prisma.pinnedMessage.findMany({
        where: { messageId: msgId },
      });
      expect(pins).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

// ===========================================================================
// POST /api/channels/:id/messages — forward branch
// ===========================================================================

describe.skipIf(!dockerOk)(
  'POST /api/channels/:id/messages — forward',
  () => {
    it('forward creates a new message referencing the original (201)', async () => {
      const ownerId = await makeUser('author');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      // Source message in the same channel (user can VIEW_CHANNEL).
      const srcId = await seedMessage(channelId, serverId, ownerId, 'original post');

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            content: '',
            forwardedFromMessageId: srcId,
          },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{
          id: string;
          forwardedFrom: { messageId: string } | null;
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.forwardedFrom).not.toBeNull();
        expect(body.data.forwardedFrom!.messageId).toBe(srcId);

        // Verify the new message row in DB.
        const row = await prisma.message.findUniqueOrThrow({
          where: { id: body.data.id },
        });
        expect(row.forwardedFromMessageId).toBe(srcId);
      } finally {
        await app.close();
      }
    });

    it('forwarding a non-existent message returns 400', async () => {
      const ownerId = await makeUser('author');
      const { channelId } = await makeServerWithChannel(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            content: '',
            forwardedFromMessageId: ulid(),
          },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('forwarding a soft-deleted message returns 400', async () => {
      const ownerId = await makeUser('author');
      const { serverId, channelId } = await makeServerWithChannel(ownerId);
      const srcId = await seedMessage(channelId, serverId, ownerId, 'deleted src');
      await prisma.message.update({
        where: { id: srcId },
        data: { deletedAt: new Date(), content: '' },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            content: '',
            forwardedFromMessageId: srcId,
          },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('a forward from a channel the user cannot VIEW_CHANNEL returns 404 (hides existence)', async () => {
      const ownerId = await makeUser('owner');
      const senderId = await makeUser('sender');
      // Create a second server with a restricted channel that senderId has no
      // access to. The source message lives there.
      const { serverId: srv2Id, everyoneRoleId, channelId: lockedChannelId } =
        await makeServerWithChannel(ownerId);
      // Deny VIEW_CHANNEL for @everyone on lockedChannel.
      await prisma.permissionOverwrite.create({
        data: {
          id: ulid(),
          channelId: lockedChannelId,
          targetType: 'role',
          targetId: everyoneRoleId,
          deny: new Prisma.Decimal(serializePermissions(Permission.VIEW_CHANNEL)),
        },
      });
      await addMember(srv2Id, senderId);
      const srcId = await seedMessage(lockedChannelId, srv2Id, ownerId, 'secret');

      // senderId has their own server+channel to forward into.
      const { channelId: destChannelId } = await makeServerWithChannel(senderId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(senderId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${destChannelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            content: '',
            forwardedFromMessageId: srcId,
          },
        });
        // Can't see the source channel → 404 (existence-hiding), not 403.
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  },
);
