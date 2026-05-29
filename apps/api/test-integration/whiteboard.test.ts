/**
 * Integration coverage for whiteboard routes in
 * `apps/api/src/routes/whiteboard.ts`.
 *
 * Endpoints covered:
 *   GET    /api/channels/:channelId/whiteboard          — fetch current state
 *   POST   /api/channels/:channelId/whiteboard/stroke   — add a stroke
 *   DELETE /api/channels/:channelId/whiteboard          — clear the canvas
 *
 * Handler check order:
 *
 * GET /api/channels/:channelId/whiteboard
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   requireChannelPermission(VIEW_CHANNEL) → 404 (VIEW_CHANNEL leaks as notFound)
 *   whiteboard.findUnique → empty state or current state
 *
 * POST /api/channels/:channelId/whiteboard/stroke
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   z.object({ stroke: strokeSchema }).parse(body) → 400
 *   requireChannelPermission(SEND_MESSAGES) → 403
 *   upsert whiteboard row, publish WHITEBOARD_STROKE → 200
 *
 * DELETE /api/channels/:channelId/whiteboard
 *   requireUser → 401
 *   idSchema.parse(params) → 400
 *   requireChannelPermission(MANAGE_MESSAGES) → 403
 *   delete (ignores not-found), publish WHITEBOARD_CLEAR → 200
 *
 * Permission notes:
 *   - PERMISSION_DEFAULT_EVERYONE includes VIEW_CHANNEL and SEND_MESSAGES
 *     but NOT MANAGE_MESSAGES — so a regular member can view and draw but
 *     cannot clear.  The owner bypasses all gates.
 *   - VIEW_CHANNEL denied → requireChannelPermission throws notFound (404),
 *     not forbidden (403).
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
// Fixtures
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

/**
 * Create a server owned by `ownerId` with an @everyone role.
 * `extraEveryonePerms` is OR-ed on top of PERMISSION_DEFAULT_EVERYONE.
 */
async function makeServer(
  ownerId: string,
  extraEveryonePerms = 0n,
): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Whiteboard Tavern' },
  });
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
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

/**
 * Server where @everyone lacks SEND_MESSAGES — used to produce 403 on the
 * stroke endpoint.
 */
async function makeServerNoSend(ownerId: string): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const noSend = PERMISSION_DEFAULT_EVERYONE & ~Permission.SEND_MESSAGES;
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'NoSend Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(noSend)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

async function makeTextChannel(serverId: string): Promise<string> {
  const id = ulid();
  await prisma.channel.create({
    data: { id, serverId, type: 'text', name: 'board' },
  });
  return id;
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

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

/** A minimal valid stroke payload as defined by strokeSchema. */
function makeStroke(opts?: {
  id?: string;
  color?: string;
  kind?: 'pen' | 'eraser';
}) {
  return {
    id: opts?.id ?? ulid(),
    points: [
      [0, 0],
      [10, 10],
    ] as [number, number][],
    color: opts?.color ?? '#ff0000',
    width: 2,
    kind: opts?.kind ?? 'pen',
  };
}

type OkBody<T> = { ok: true; data: T };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('whiteboard routes (apps/api/src/routes/whiteboard.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // =========================================================================
  // GET /api/channels/:channelId/whiteboard
  // =========================================================================

  describe('GET /api/channels/:channelId/whiteboard — guards', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${ulid()}/whiteboard`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist (VIEW_CHANNEL leaks as notFound)', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${ulid()}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when caller is not a server member (VIEW_CHANNEL denied → notFound)', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      // outsiderId is NOT added to the server
      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  describe('GET /api/channels/:channelId/whiteboard — happy path', () => {
    it('returns empty state when no whiteboard row exists', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          channelId: string;
          strokes: unknown[];
          updatedBy: string | null;
          updatedAt: string | null;
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.channelId).toBe(channelId);
        expect(body.data.strokes).toEqual([]);
        expect(body.data.updatedBy).toBeNull();
        expect(body.data.updatedAt).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('returns existing strokes when a whiteboard row is present', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);

      const stroke = makeStroke({ id: 'stroke-1', color: '#0000ff' });
      await prisma.whiteboard.create({
        data: {
          id: ulid(),
          channelId,
          strokesJson: [stroke],
          updatedBy: ownerId,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          channelId: string;
          strokes: Array<{ id: string; color: string; kind: string }>;
          updatedBy: string;
          updatedAt: string;
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.channelId).toBe(channelId);
        expect(body.data.strokes).toHaveLength(1);
        expect(body.data.strokes[0]!.id).toBe('stroke-1');
        expect(body.data.strokes[0]!.color).toBe('#0000ff');
        expect(body.data.updatedBy).toBe(ownerId);
        expect(body.data.updatedAt).toBeTruthy();
      } finally {
        await app.close();
      }
    });

    it('member with VIEW_CHANNEL can read the whiteboard', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/channels/:channelId/whiteboard/stroke
  // =========================================================================

  describe('POST /api/channels/:channelId/whiteboard/stroke — guards', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${ulid()}/whiteboard/stroke`,
          payload: { stroke: makeStroke() },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the body is missing the stroke field', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when stroke has no points', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            stroke: {
              id: ulid(),
              points: [],
              color: '#ff0000',
              width: 2,
              kind: 'pen',
            },
          },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when stroke kind is invalid', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            stroke: {
              id: ulid(),
              points: [[0, 0]],
              color: '#ff0000',
              width: 2,
              kind: 'highlighter', // not in enum
            },
          },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${ulid()}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stroke: makeStroke() },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when caller lacks SEND_MESSAGES', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServerNoSend(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stroke: makeStroke() },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe('POST /api/channels/:channelId/whiteboard/stroke — happy path', () => {
    it('creates a new whiteboard row on first stroke (200) and stores it in DB', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      const stroke = makeStroke({ id: 'first-stroke', color: '#00ff00', kind: 'pen' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stroke },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        const wb = await prisma.whiteboard.findUnique({ where: { channelId } });
        expect(wb).not.toBeNull();
        expect(wb!.updatedBy).toBe(ownerId);
        const strokes = wb!.strokesJson as Array<{ id: string }>;
        expect(strokes).toHaveLength(1);
        expect(strokes[0]!.id).toBe('first-stroke');
      } finally {
        await app.close();
      }
    });

    it('appends a stroke to an existing whiteboard (200) and updates the row', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);

      const existingStroke = makeStroke({ id: 'existing', color: '#ff0000' });
      await prisma.whiteboard.create({
        data: {
          id: ulid(),
          channelId,
          strokesJson: [existingStroke],
          updatedBy: ownerId,
        },
      });

      const newStroke = makeStroke({ id: 'new-stroke', color: '#0000ff' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stroke: newStroke },
        });
        expect(res.statusCode).toBe(200);

        const wb = await prisma.whiteboard.findUnique({ where: { channelId } });
        const strokes = wb!.strokesJson as Array<{ id: string }>;
        expect(strokes).toHaveLength(2);
        expect(strokes.map((s) => s.id)).toContain('existing');
        expect(strokes.map((s) => s.id)).toContain('new-stroke');
      } finally {
        await app.close();
      }
    });

    it('member with SEND_MESSAGES can add a stroke (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stroke: makeStroke() },
        });
        expect(res.statusCode).toBe(200);
        const wb = await prisma.whiteboard.findUnique({ where: { channelId } });
        expect(wb!.updatedBy).toBe(memberId);
      } finally {
        await app.close();
      }
    });

    it('accepts eraser kind strokes (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/whiteboard/stroke`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stroke: makeStroke({ kind: 'eraser' }) },
        });
        expect(res.statusCode).toBe(200);
        const wb = await prisma.whiteboard.findUnique({ where: { channelId } });
        const strokes = wb!.strokesJson as Array<{ kind: string }>;
        expect(strokes[0]!.kind).toBe('eraser');
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // DELETE /api/channels/:channelId/whiteboard — clear the canvas
  // =========================================================================

  describe('DELETE /api/channels/:channelId/whiteboard — guards', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${ulid()}/whiteboard`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${ulid()}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when caller lacks MANAGE_MESSAGES (member cannot clear)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      // PERMISSION_DEFAULT_EVERYONE does NOT include MANAGE_MESSAGES
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const channelId = await makeTextChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe('DELETE /api/channels/:channelId/whiteboard — happy path', () => {
    it('owner clears the whiteboard (200) and the DB row is deleted', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);

      await prisma.whiteboard.create({
        data: {
          id: ulid(),
          channelId,
          strokesJson: [makeStroke()],
          updatedBy: ownerId,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        const wb = await prisma.whiteboard.findUnique({ where: { channelId } });
        expect(wb).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('clear is idempotent — returns 200 even when no whiteboard row exists', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);
      // No whiteboard row seeded
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('member with MANAGE_MESSAGES (granted via extra perm) can clear (200)', async () => {
      const ownerId = await makeUser('owner');
      const modId = await makeUser('mod');
      // Grant MANAGE_MESSAGES to @everyone so the mod can clear
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_MESSAGES);
      await addMember(serverId, modId);
      const channelId = await makeTextChannel(serverId);

      await prisma.whiteboard.create({
        data: {
          id: ulid(),
          channelId,
          strokesJson: [makeStroke()],
          updatedBy: ownerId,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(modId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);

        const wb = await prisma.whiteboard.findUnique({ where: { channelId } });
        expect(wb).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('after clear a subsequent GET returns the empty state', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelId = await makeTextChannel(serverId);

      await prisma.whiteboard.create({
        data: {
          id: ulid(),
          channelId,
          strokesJson: [makeStroke(), makeStroke()],
          updatedBy: ownerId,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        await app.inject({
          method: 'DELETE',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });

        const res = await app.inject({
          method: 'GET',
          url: `/api/channels/${channelId}/whiteboard`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ strokes: unknown[] }>;
        expect(body.data.strokes).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });
});
