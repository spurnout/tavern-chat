/**
 * Integration coverage for channel message pins in
 * `apps/api/src/routes/pins.ts`.
 *
 * Routes under test:
 *   GET    /api/channels/:id/pins            — list pins (VIEW_CHANNEL required)
 *   POST   /api/channels/:id/pins/:messageId — pin a message (MANAGE_MESSAGES required)
 *   DELETE /api/channels/:id/pins/:messageId — unpin a message (MANAGE_MESSAGES required)
 *
 * Coverage matrix:
 *   GET  — 200 with pin list + shape check, 200 empty list, 401, 403 (VIEW_CHANNEL denied)
 *   POST — 201 pin created + DB state + response shape, 201 idempotent re-pin updates note,
 *           401, 403 (missing MANAGE_MESSAGES), 400 (message from different channel),
 *           400 (target message deleted)
 *   DELETE — 200 pin removed + DB state, 401, 403, 404 (pin not found),
 *             404 (pin belongs to different channel)
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
 * `extraPerms` is OR-ed onto the default @everyone bitset; pass
 * `Permission.MANAGE_MESSAGES` to make all members able to pin/unpin.
 */
async function makeServerWithChannel(
  ownerId: string,
  extraPerms = 0n,
): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Pins Tavern' },
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

/** Seed a message directly via Prisma — used to set up pin targets. */
async function seedMessage(
  channelId: string,
  serverId: string,
  authorId: string,
  content = 'pinnable content',
): Promise<string> {
  const id = ulid();
  await prisma.message.create({
    data: { id, serverId, channelId, authorId, type: 'default', content },
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
// beforeEach: FK-safe teardown (children first)
// ---------------------------------------------------------------------------

beforeEach(async () => {
  if (!dockerOk) return;
  await prisma.apiToken.deleteMany({});
  await prisma.pinnedMessage.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.userMention.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
});

// ===========================================================================
// GET /api/channels/:id/pins
// ===========================================================================

describe.skipIf(!dockerOk)('GET /api/channels/:id/pins — list pins', () => {
  it('returns an empty array when no messages are pinned (200)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/pins`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('returns pinned messages with correct shape (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId);
    // Pin manually.
    await prisma.pinnedMessage.create({
      data: { messageId: msgId, channelId, pinnedBy: ownerId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/pins`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<
        Array<{
          channelId: string;
          messageId: string;
          pinnedBy: string;
          pinnedAt: string;
          note: string | null;
          message: { id: string; content: string };
        }>
      >;
      expect(body.data).toHaveLength(1);
      const pin = body.data[0]!;
      expect(pin.channelId).toBe(channelId);
      expect(pin.messageId).toBe(msgId);
      expect(pin.pinnedBy).toBe(ownerId);
      expect(pin.pinnedAt).toBeTruthy();
      expect(pin.message.id).toBe(msgId);
      expect(pin.message.content).toBe('pinnable content');
    } finally {
      await app.close();
    }
  });

  it('returns pins ordered newest-first (pinnedAt desc)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId1 = await seedMessage(channelId, serverId, ownerId, 'first pinned');
    const msgId2 = await seedMessage(channelId, serverId, ownerId, 'second pinned');
    // Pin msgId1 first, then msgId2.
    await prisma.pinnedMessage.create({
      data: {
        messageId: msgId1,
        channelId,
        pinnedBy: ownerId,
        pinnedAt: new Date(Date.now() - 10_000),
      },
    });
    await prisma.pinnedMessage.create({
      data: { messageId: msgId2, channelId, pinnedBy: ownerId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/pins`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ messageId: string }>>;
      expect(body.data[0]!.messageId).toBe(msgId2);
      expect(body.data[1]!.messageId).toBe(msgId1);
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
        url: `/api/channels/${channelId}/pins`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the caller lacks VIEW_CHANNEL — the route hides channel existence', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, everyoneRoleId, channelId } =
      await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    // Deny VIEW_CHANNEL for @everyone.
    await prisma.permissionOverwrite.create({
      data: {
        id: ulid(),
        channelId,
        targetType: 'role',
        targetId: everyoneRoleId,
        deny: new Prisma.Decimal(serializePermissions(Permission.VIEW_CHANNEL)),
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/pins`,
        headers: { authorization: `Bearer ${token}` },
      });
      // VIEW_CHANNEL denial resolves to 404 (existence-hiding), not 403.
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ===========================================================================
// POST /api/channels/:id/pins/:messageId — pin a message
// ===========================================================================

describe.skipIf(!dockerOk)('POST /api/channels/:id/pins/:messageId — pin', () => {
  it('creates a pin (201), DB row present, response shape correct', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        channelId: string;
        messageId: string;
        pinnedBy: string;
        pinnedAt: string;
        note: string | null;
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.messageId).toBe(msgId);
      expect(body.data.pinnedBy).toBe(ownerId);
      expect(body.data.pinnedAt).toBeTruthy();
      expect(body.data.note).toBeNull();

      // DB state.
      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row).not.toBeNull();
      expect(row!.channelId).toBe(channelId);
      expect(row!.pinnedBy).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('pin accepts an optional note and persists it', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { note: 'important rule' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ note: string | null }>;
      expect(body.data.note).toBe('important rule');

      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row!.note).toBe('important rule');
    } finally {
      await app.close();
    }
  });

  it('re-pinning an already-pinned message is idempotent (201) and updates the actor + note', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    await addMember(serverId, modId);
    const msgId = await seedMessage(channelId, serverId, ownerId);
    // Initial pin by owner.
    await prisma.pinnedMessage.create({
      data: { messageId: msgId, channelId, pinnedBy: ownerId, note: 'old note' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { note: 'new note' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ pinnedBy: string; note: string | null }>;
      expect(body.data.pinnedBy).toBe(modId);
      expect(body.data.note).toBe('new note');

      // Still only one row.
      const count = await prisma.pinnedMessage.count({ where: { messageId: msgId } });
      expect(count).toBe(1);
      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row!.pinnedBy).toBe(modId);
      expect(row!.note).toBe('new note');
    } finally {
      await app.close();
    }
  });

  it('returns 401 when no bearer token is provided', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the caller lacks MANAGE_MESSAGES', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    // @everyone does NOT have MANAGE_MESSAGES by default.
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const msgId = await seedMessage(channelId, serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);

      // No pin row created.
      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 400 when the target message does not exist', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 400 when the target message belongs to a different channel', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    // Create a second channel in the same server.
    const otherChannelId = ulid();
    await prisma.channel.create({
      data: { id: otherChannelId, serverId, type: 'text', name: 'other' },
    });
    // Message lives in otherChannelId.
    const msgId = await seedMessage(otherChannelId, serverId, ownerId, 'wrong channel');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      // Try to pin it via channelId (not its actual channel).
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 400 when the target message is soft-deleted', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId, 'deleted');
    await prisma.message.update({
      where: { id: msgId },
      data: { deletedAt: new Date(), content: '' },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects a note that exceeds 280 characters (400)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { note: 'x'.repeat(281) },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ===========================================================================
// DELETE /api/channels/:id/pins/:messageId — unpin
// ===========================================================================

describe.skipIf(!dockerOk)('DELETE /api/channels/:id/pins/:messageId — unpin', () => {
  it('unpin removes the PinnedMessage row (200) and returns channel + messageId', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId);
    await prisma.pinnedMessage.create({
      data: { messageId: msgId, channelId, pinnedBy: ownerId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ channelId: string; messageId: string }>;
      expect(body.ok).toBe(true);
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.messageId).toBe(msgId);

      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 401 when no bearer token is provided', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const msgId = await seedMessage(channelId, serverId, ownerId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/pins/${msgId}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the caller lacks MANAGE_MESSAGES', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const msgId = await seedMessage(channelId, serverId, ownerId);
    await prisma.pinnedMessage.create({
      data: { messageId: msgId, channelId, pinnedBy: ownerId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);

      // Pin still exists.
      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 404 when no pin exists for the message', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    const msgId = await seedMessage(channelId, serverId, ownerId);
    // No pin created.

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when a pin exists but belongs to a different channel', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(
      ownerId,
      Permission.MANAGE_MESSAGES,
    );
    // Create a second channel.
    const otherChannelId = ulid();
    await prisma.channel.create({
      data: { id: otherChannelId, serverId, type: 'text', name: 'other' },
    });
    const msgId = await seedMessage(otherChannelId, serverId, ownerId, 'wrong channel msg');
    // Pin the message under the other channel.
    await prisma.pinnedMessage.create({
      data: { messageId: msgId, channelId: otherChannelId, pinnedBy: ownerId },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      // Attempt unpin via channelId (wrong channel).
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/channels/${channelId}/pins/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);

      // Pin in the other channel is untouched.
      const row = await prisma.pinnedMessage.findUnique({ where: { messageId: msgId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
