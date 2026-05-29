/**
 * Integration coverage for the dice-roll surface in
 * `apps/api/src/routes/dice.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Routes covered:
 *   POST  /api/dice/roll         — roll dice in a channel or DM channel
 *   GET   /api/channels/:id/dice — list dice rolls visible to the caller
 *
 * Permission model:
 *   - POST requires ROLL_DICE on the target channel.
 *   - POST with visibility !== 'public' additionally requires ROLL_PRIVATE_DICE.
 *   - GET  requires READ_MESSAGE_HISTORY on the channel.
 *   - PERMISSION_DEFAULT_EVERYONE includes ROLL_DICE + READ_MESSAGE_HISTORY
 *     but NOT ROLL_PRIVATE_DICE.
 *   - The server owner always bypasses permission gates.
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

/** Server with an @everyone role (default perms include ROLL_DICE) + one text channel. */
async function makeServerWithChannel(
  ownerId: string,
  extraEveryonePerms = 0n,
): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Dice Tavern' } });
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

describe.skipIf(!dockerOk)('dice routes (apps/api/src/routes/dice.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.diceRoll.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- POST /api/dice/roll -----------------------------------------------

  it('server owner rolls a public die in a channel (201), diceRoll + message rows created', async () => {
    const ownerId = await makeUser('owner');
    const { channelId, serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '1d6', visibility: 'public' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        serverId: string;
        channelId: string;
        messageId: string | null;
        userId: string;
        notation: string;
        total: number;
        visibility: string;
        result: { terms: unknown[]; total: number };
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.userId).toBe(ownerId);
      expect(body.data.notation).toBe('1d6');
      expect(body.data.visibility).toBe('public');
      expect(typeof body.data.total).toBe('number');
      expect(body.data.messageId).toBeTruthy();

      // DB: diceRoll row
      const roll = await prisma.diceRoll.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(roll.channelId).toBe(channelId);
      expect(roll.userId).toBe(ownerId);

      // DB: message row of type dice_roll
      const msg = await prisma.message.findUnique({ where: { id: body.data.messageId! } });
      expect(msg).not.toBeNull();
      expect(msg?.type).toBe('dice_roll');
      expect(msg?.diceRollId).toBe(roll.id);
    } finally {
      await app.close();
    }
  });

  it('member with default perms (ROLL_DICE in @everyone) can roll publicly (201)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '2d8', visibility: 'public' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; userId: string; total: number }>;
      expect(body.data.userId).toBe(memberId);
      // total should be in range [2, 16]
      expect(body.data.total).toBeGreaterThanOrEqual(2);
      expect(body.data.total).toBeLessThanOrEqual(16);
    } finally {
      await app.close();
    }
  });

  it('private roll (visibility=private) is stored with no message row when caller has ROLL_PRIVATE_DICE', async () => {
    const ownerId = await makeUser('owner');
    // Grant ROLL_PRIVATE_DICE via extra everyone perms
    const { channelId, everyoneId } = await makeServerWithChannel(
      ownerId,
      Permission.ROLL_PRIVATE_DICE,
    );
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '1d20', visibility: 'private' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; messageId: string | null; visibility: string }>;
      expect(body.data.visibility).toBe('private');
      // private rolls don't create a public message
      expect(body.data.messageId).toBeNull();

      const msg = await prisma.message.count({ where: { diceRollId: body.data.id } });
      expect(msg).toBe(0);
      void everyoneId; // used in fixture
    } finally {
      await app.close();
    }
  });

  it('gm_only roll is stored with no message row (and no ROLL_PRIVATE_DICE check for owner)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '1d12', visibility: 'gm_only' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; messageId: string | null; visibility: string }>;
      expect(body.data.visibility).toBe('gm_only');
      expect(body.data.messageId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('private roll 403 when caller lacks ROLL_PRIVATE_DICE (member with default @everyone perms)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    // Default @everyone does NOT have ROLL_PRIVATE_DICE
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '1d20', visibility: 'private' },
      });
      expect(res.statusCode).toBe(403);
      // No row created
      const count = await prisma.diceRoll.count({ where: { channelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 403 when a channel overwrite denies ROLL_DICE', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    // Deny ROLL_DICE on the @everyone overwrite for this channel
    await prisma.permissionOverwrite.create({
      data: {
        id: ulid(),
        channelId,
        targetType: 'role',
        targetId: everyoneId,
        allow: new Prisma.Decimal('0'),
        deny: new Prisma.Decimal(serializePermissions(Permission.ROLL_DICE)),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '1d6', visibility: 'public' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 401 when no auth token is provided', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        payload: { channelId: ulid(), notation: '1d6' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 400 when notation is missing (zod validation)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId }, // missing notation
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 400 when neither channelId nor dmChannelId is provided (schema refine)', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { notation: '1d6' }, // neither channelId nor dmChannelId
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 400 when both channelId and dmChannelId are provided (schema refine)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, dmChannelId: ulid(), notation: '1d6' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 400 when notation is an invalid dice expression', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: 'not-a-dice-expression!!!' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll is 404 when channelId references a channel that does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId: ulid(), notation: '1d6' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/dice/roll with a label stores the label on the diceRoll row', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dice/roll',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, notation: '1d6', label: 'Attack roll', visibility: 'public' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; label: string | null }>;
      expect(body.data.label).toBe('Attack roll');
      const roll = await prisma.diceRoll.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(roll.label).toBe('Attack roll');
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/channels/:id/dice ----------------------------------------

  it('GET /api/channels/:id/dice returns 200 with an array of visible rolls', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    // Create two rolls directly in DB
    await prisma.diceRoll.createMany({
      data: [
        {
          id: ulid(),
          channelId,
          userId: ownerId,
          notation: '1d6',
          resultJson: { notation: '1d6', terms: [], total: 4 },
          total: 4,
          visibility: 'public',
        },
        {
          id: ulid(),
          channelId,
          userId: ownerId,
          notation: '1d20',
          resultJson: { notation: '1d20', terms: [], total: 15 },
          total: 15,
          visibility: 'public',
        },
      ],
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; channelId: string; total: number }>>;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(2);
      expect(body.data.every((r) => r.channelId === channelId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice filters out private rolls from other users', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    // Owner has a private roll
    await prisma.diceRoll.create({
      data: {
        id: ulid(),
        channelId,
        userId: ownerId,
        notation: '1d20',
        resultJson: { notation: '1d20', terms: [], total: 10 },
        total: 10,
        visibility: 'private',
      },
    });
    // Member has a public roll
    await prisma.diceRoll.create({
      data: {
        id: ulid(),
        channelId,
        userId: memberId,
        notation: '1d6',
        resultJson: { notation: '1d6', terms: [], total: 3 },
        total: 3,
        visibility: 'public',
      },
    });
    const app = await buildTestApp();
    try {
      // Member can see their own public roll but NOT owner's private roll
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ visibility: string; userId: string }>>;
      // Should not include owner's private roll
      expect(body.data.some((r) => r.visibility === 'private' && r.userId === ownerId)).toBe(false);
      // Should include member's public roll
      expect(body.data.some((r) => r.userId === memberId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice member can see their own private roll', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const rollId = ulid();
    await prisma.diceRoll.create({
      data: {
        id: rollId,
        channelId,
        userId: memberId,
        notation: '1d20',
        resultJson: { notation: '1d20', terms: [], total: 17 },
        total: 17,
        visibility: 'private',
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string }>>;
      expect(body.data.some((r) => r.id === rollId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice is 401 when no auth token is provided', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice is 403 when a channel overwrite denies READ_MESSAGE_HISTORY', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    // Deny READ_MESSAGE_HISTORY via channel overwrite
    await prisma.permissionOverwrite.create({
      data: {
        id: ulid(),
        channelId,
        targetType: 'role',
        targetId: everyoneId,
        allow: new Prisma.Decimal('0'),
        deny: new Prisma.Decimal(serializePermissions(Permission.READ_MESSAGE_HISTORY)),
      },
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice is 404 for an unknown channel', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${ulid()}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice returns empty array when no rolls exist', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/dice returns at most 50 rolls (take limit)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    // Insert 55 public rolls directly
    await prisma.diceRoll.createMany({
      data: Array.from({ length: 55 }, () => ({
        id: ulid(),
        channelId,
        userId: ownerId,
        notation: '1d4',
        resultJson: { notation: '1d4', terms: [], total: 2 },
        total: 2,
        visibility: 'public' as const,
      })),
    });
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/dice`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data.length).toBeLessThanOrEqual(50);
    } finally {
      await app.close();
    }
  });
});
