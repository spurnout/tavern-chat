/**
 * Integration coverage for the scheduled-dispatch surface in
 * `apps/api/src/routes/scheduled.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Routes covered:
 *   GET    /api/me/scheduled         — list caller's scheduled dispatches
 *   POST   /api/me/scheduled         — create a scheduled message or reminder
 *   PATCH  /api/me/scheduled/:id     — update a pending dispatch
 *   DELETE /api/me/scheduled/:id     — cancel a pending dispatch
 *
 * Key behaviours:
 *   - All routes require authentication (401 when absent).
 *   - POST kind='message' requires SEND_MESSAGES in the target channel (403).
 *   - POST kind='reminder' has no channel permission check.
 *   - dispatchAt must be > now + 5 s (400 if in the past or too near).
 *   - PATCH / DELETE on another user's dispatch → 404 (not 403, intentional).
 *   - PATCH on a non-pending dispatch → 400 'Already dispatched'.
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

/** Server with @everyone role (default perms include SEND_MESSAGES) + one text channel. */
async function makeServerWithChannel(
  ownerId: string,
): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Scheduled Tavern' } });
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
  return { serverId, channelId, everyoneId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
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

/** Returns a valid ISO dispatch timestamp 60 seconds in the future. */
function futureDispatchAt(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe.skipIf(!dockerOk)('scheduled dispatch routes (apps/api/src/routes/scheduled.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.scheduledDispatch.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/me/scheduled -------------------------------------------

  it('GET /api/me/scheduled returns 200 with an empty array when no dispatches exist', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/scheduled',
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

  it('GET /api/me/scheduled returns only the caller\'s own dispatches, ordered by dispatchAt asc', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const dispatchAt1 = new Date(Date.now() + 120_000);
    const dispatchAt2 = new Date(Date.now() + 60_000);
    await prisma.scheduledDispatch.createMany({
      data: [
        {
          id: ulid(),
          userId: aliceId,
          kind: 'reminder',
          payload: { text: 'alice first' },
          dispatchAt: dispatchAt1,
        },
        {
          id: ulid(),
          userId: aliceId,
          kind: 'reminder',
          payload: { text: 'alice second' },
          dispatchAt: dispatchAt2,
        },
        {
          id: ulid(),
          userId: bobId,
          kind: 'reminder',
          payload: { text: 'bob item' },
          dispatchAt: dispatchAt1,
        },
      ],
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ payload: { text: string }; dispatchAt: string }>>;
      expect(body.data).toHaveLength(2);
      // ordered by dispatchAt asc — dispatchAt2 is sooner
      expect(new Date(body.data[0]!.dispatchAt).getTime()).toBeLessThanOrEqual(
        new Date(body.data[1]!.dispatchAt).getTime(),
      );
      // Bob's item is not visible
      expect(body.data.some((r) => r.payload.text === 'bob item')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/scheduled is 401 when no auth token is provided', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/scheduled',
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/me/scheduled (kind=reminder) ---------------------------

  it('POST creates a reminder (201) and the row is persisted with status=pending', async () => {
    const userId = await makeUser('user');
    const dispatchAt = futureDispatchAt();
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'reminder',
          dispatchAt,
          payload: { text: 'check on the campaign' },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        kind: string;
        status: string;
        dispatchAt: string;
        payload: { text: string };
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.kind).toBe('reminder');
      expect(body.data.status).toBe('pending');
      expect(body.data.payload).toEqual({ text: 'check on the campaign' });

      const row = await prisma.scheduledDispatch.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.status).toBe('pending');
      expect(row.userId).toBe(userId);
    } finally {
      await app.close();
    }
  });

  it('POST creates a scheduled message (201) when the caller has SEND_MESSAGES', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const dispatchAt = futureDispatchAt();
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'message',
          channelId,
          dispatchAt,
          payload: { content: 'Hello future room!' },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; kind: string; channelId: string; status: string }>;
      expect(body.data.kind).toBe('message');
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.status).toBe('pending');

      const row = await prisma.scheduledDispatch.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.channelId).toBe(channelId);
    } finally {
      await app.close();
    }
  });

  it('POST is 403 when kind=message and caller lacks SEND_MESSAGES (channel overwrite deny)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    // Deny SEND_MESSAGES via overwrite
    await prisma.permissionOverwrite.create({
      data: {
        id: ulid(),
        channelId,
        targetType: 'role',
        targetId: everyoneId,
        allow: new Prisma.Decimal('0'),
        deny: new Prisma.Decimal(serializePermissions(Permission.SEND_MESSAGES)),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'message',
          channelId,
          dispatchAt: futureDispatchAt(),
          payload: { content: 'sneaky message' },
        },
      });
      expect(res.statusCode).toBe(403);
      // No dispatch row written
      const count = await prisma.scheduledDispatch.count({ where: { userId: memberId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when dispatchAt is in the past', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'reminder',
          dispatchAt: pastTime,
          payload: { text: 'too late' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when dispatchAt is fewer than 5 seconds in the future', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      // 2 seconds from now — inside the 5 s guard
      const nearFuture = new Date(Date.now() + 2_000).toISOString();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'reminder',
          dispatchAt: nearFuture,
          payload: { text: 'too soon' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when kind=message but channelId is omitted (superRefine)', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'message',
          // no channelId
          dispatchAt: futureDispatchAt(),
          payload: { content: 'oops' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when kind field is missing', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          // missing kind
          dispatchAt: futureDispatchAt(),
          payload: { text: 'no kind' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 400 when dispatchAt is not a valid datetime string', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'reminder',
          dispatchAt: 'not-a-date',
          payload: { text: 'bad date' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST is 404 when kind=message and channelId references a non-existent channel', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: 'message',
          channelId: ulid(),
          dispatchAt: futureDispatchAt(),
          payload: { content: 'ghost channel' },
        },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST is 401 when no auth token is provided', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/scheduled',
        payload: {
          kind: 'reminder',
          dispatchAt: futureDispatchAt(),
          payload: { text: 'anonymous' },
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/me/scheduled/:id -------------------------------------

  it('PATCH updates dispatchAt and payload on a pending dispatch (200)', async () => {
    const userId = await makeUser('user');
    const dispatchId = ulid();
    const originalAt = new Date(Date.now() + 60_000);
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId,
        kind: 'reminder',
        payload: { text: 'original' },
        dispatchAt: originalAt,
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const newAt = futureDispatchAt(120_000);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: { text: 'updated' },
          dispatchAt: newAt,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        id: string;
        status: string;
        dispatchAt: string;
        payload: { text: string };
      }>;
      expect(body.data.id).toBe(dispatchId);
      expect(body.data.status).toBe('pending');

      const row = await prisma.scheduledDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
      expect((row.payload as { text: string }).text).toBe('updated');
    } finally {
      await app.close();
    }
  });

  it('PATCH is 400 when trying to update a dispatch that is already sent', async () => {
    const userId = await makeUser('user');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId,
        kind: 'reminder',
        payload: { text: 'done' },
        dispatchAt: new Date(Date.now() - 60_000),
        status: 'sent',
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { payload: { text: 'too late to change' } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 400 when trying to update a cancelled dispatch', async () => {
    const userId = await makeUser('user');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId,
        kind: 'reminder',
        payload: { text: 'cancelled' },
        dispatchAt: new Date(Date.now() + 60_000),
        status: 'cancelled',
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { payload: { text: 'revive' } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 400 when the new dispatchAt is fewer than 5 seconds in the future', async () => {
    const userId = await makeUser('user');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId,
        kind: 'reminder',
        payload: { text: 'hi' },
        dispatchAt: new Date(Date.now() + 60_000),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const nearFuture = new Date(Date.now() + 2_000).toISOString();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { dispatchAt: nearFuture },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 404 for a dispatch that belongs to a different user', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId: aliceId,
        kind: 'reminder',
        payload: { text: 'alices' },
        dispatchAt: new Date(Date.now() + 60_000),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(bobId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { payload: { text: 'hijack' } },
      });
      expect(res.statusCode).toBe(404);
      // Alice's data unchanged
      const row = await prisma.scheduledDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
      expect((row.payload as { text: string }).text).toBe('alices');
    } finally {
      await app.close();
    }
  });

  it('PATCH is 404 for an unknown dispatch id', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { payload: { text: 'ghost' } },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH is 401 when no auth token is provided', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/me/scheduled/${ulid()}`,
        payload: { payload: { text: 'anon' } },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/me/scheduled/:id ------------------------------------

  it('DELETE cancels a pending dispatch (200) and sets status=cancelled', async () => {
    const userId = await makeUser('user');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId,
        kind: 'reminder',
        payload: { text: 'to be cancelled' },
        dispatchAt: new Date(Date.now() + 60_000),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; status: string }>;
      expect(body.data.id).toBe(dispatchId);
      expect(body.data.status).toBe('cancelled');

      const row = await prisma.scheduledDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
      expect(row.status).toBe('cancelled');
    } finally {
      await app.close();
    }
  });

  it('DELETE on an already-cancelled dispatch returns 200 (idempotent — status already cancelled)', async () => {
    const userId = await makeUser('user');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId,
        kind: 'reminder',
        payload: { text: 'already done' },
        dispatchAt: new Date(Date.now() + 60_000),
        status: 'cancelled',
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      // Route returns ok regardless of prior status (only skips DB update)
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; status: string }>;
      expect(body.data.status).toBe('cancelled');
    } finally {
      await app.close();
    }
  });

  it('DELETE is 404 for a dispatch belonging to a different user', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const dispatchId = ulid();
    await prisma.scheduledDispatch.create({
      data: {
        id: dispatchId,
        userId: aliceId,
        kind: 'reminder',
        payload: { text: 'alices' },
        dispatchAt: new Date(Date.now() + 60_000),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(bobId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/scheduled/${dispatchId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      // Alice's dispatch should still be pending
      const row = await prisma.scheduledDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
      expect(row.status).toBe('pending');
    } finally {
      await app.close();
    }
  });

  it('DELETE is 404 for an unknown dispatch id', async () => {
    const userId = await makeUser('user');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/scheduled/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE is 401 when no auth token is provided', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/scheduled/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
