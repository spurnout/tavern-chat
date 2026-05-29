/**
 * Integration coverage for the random-table surface in
 * `apps/api/src/routes/random-tables.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model these routes encode:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent.
 *   - GET /api/servers/:id/tables → server VIEW_CHANNEL (default @everyone has
 *     it, so any member passes; a non-member with no perms is 403).
 *   - POST /api/servers/:id/tables → server CREATE_CAMPAIGNS (GM-level intent).
 *     The default @everyone bitset does NOT include it, so a plain member is
 *     403; the owner holds every permission and passes. The dice notation is
 *     validated up-front → bad notation is 400.
 *   - DELETE /api/tables/:id → the table owner, OR (for anyone else) server
 *     MANAGE_CAMPAIGNS. Missing table → 404.
 *   - POST /api/tables/:id/roll → no table-level permission to *roll*; it only
 *     needs an authenticated user. When `channelId` is supplied the caller
 *     must hold SEND_MESSAGES in that channel, and a `dice_roll` message is
 *     persisted + published. Missing table → 404.
 *
 * Fixtures mirror characters.test.ts / encounters.test.ts: a server (owner ==
 * the privileged actor) with an @everyone role whose bitset we tune per-test,
 * one text channel, and an optional campaign. Federation is off so no route
 * touches the outbound queue.
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
 * @everyone bitset (e.g. to grant CREATE_CAMPAIGNS / MANAGE_CAMPAIGNS to every
 * member, separate from the owner shortcut).
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Table Tavern' } });
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

interface TableSeedOptions {
  campaignId?: string | null;
  name?: string;
  diceNotation?: string;
  rows?: Array<{ rangeMin: number; rangeMax: number; label: string; resultText?: string; weight?: number }>;
}

/** Seed a random table (+ rows) directly so DELETE/roll fixtures don't depend on POST. */
async function makeTable(
  serverId: string,
  ownerId: string,
  opts: TableSeedOptions = {},
): Promise<string> {
  const tableId = ulid();
  await prisma.randomTable.create({
    data: {
      id: tableId,
      serverId,
      campaignId: opts.campaignId ?? null,
      name: opts.name ?? 'Loot Table',
      diceNotation: opts.diceNotation ?? '1d100',
      ownerId,
    },
  });
  const rows = opts.rows ?? [];
  if (rows.length > 0) {
    await prisma.randomTableRow.createMany({
      data: rows.map((r) => ({
        id: ulid(),
        tableId,
        rangeMin: r.rangeMin,
        rangeMax: r.rangeMax,
        label: r.label,
        weight: r.weight ?? 1,
        resultText: r.resultText ?? r.label,
      })),
    });
  }
  return tableId;
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
type TableRowDto = {
  id: string;
  tableId: string;
  rangeMin: number;
  rangeMax: number;
  label: string;
  weight: number;
  resultText: string;
};
type TableDto = {
  id: string;
  serverId: string;
  campaignId: string | null;
  name: string;
  diceNotation: string;
  ownerId: string;
  createdAt: string;
  rows: TableRowDto[];
};
type RollDto = {
  tableId: string;
  roll: { total: number };
  matchedRow: { id: string; label: string; resultText: string } | null;
  messageId: string | null;
};

describe.skipIf(!dockerOk)('random-table routes (apps/api/src/routes/random-tables.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.randomTableRow.deleteMany({});
    await prisma.randomTable.deleteMany({});
    await prisma.campaignMember.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET /api/servers/:id/tables ------------------------------------

  it('lists server tables for a member, ordered by name asc, with rows by rangeMin', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeTable(serverId, ownerId, {
      name: 'Zeta',
      rows: [
        { rangeMin: 51, rangeMax: 100, label: 'High' },
        { rangeMin: 1, rangeMax: 50, label: 'Low' },
      ],
    });
    await makeTable(serverId, ownerId, { name: 'Alpha' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<TableDto[]>;
      expect(body.data.map((t) => t.name)).toEqual(['Alpha', 'Zeta']);
      const zeta = body.data.find((t) => t.name === 'Zeta')!;
      expect(zeta.rows.map((r) => r.label)).toEqual(['Low', 'High']);
    } finally {
      await app.close();
    }
  });

  it('GET .../tables is 403 for a non-member (no VIEW_CHANNEL)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    await makeTable(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET .../tables without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/servers/${ulid()}/tables` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/servers/:id/tables -----------------------------------

  it('the owner can create a table with rows (201), owned by the caller; rows persist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Wild Magic',
          diceNotation: '1d20',
          rows: [
            { rangeMin: 1, rangeMax: 10, label: 'Sparks', resultText: 'Harmless sparks fly.' },
            { rangeMin: 11, rangeMax: 20, label: 'Boom', resultText: 'A small explosion.' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<TableDto>;
      expect(body.data.name).toBe('Wild Magic');
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.ownerId).toBe(ownerId);
      expect(body.data.diceNotation).toBe('1d20');
      expect(body.data.rows).toHaveLength(2);

      const rowCount = await prisma.randomTableRow.count({ where: { tableId: body.data.id } });
      expect(rowCount).toBe(2);
      const tableRow = await prisma.randomTable.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(tableRow.ownerId).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('a member WITH CREATE_CAMPAIGNS can create a table (201)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.CREATE_CAMPAIGNS);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Member Table', rows: [{ rangeMin: 1, rangeMax: 100, label: 'X', resultText: 'x' }] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<TableDto>;
      expect(body.data.ownerId).toBe(memberId);
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT CREATE_CAMPAIGNS cannot create a table (403), no row written', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Denied', rows: [{ rangeMin: 1, rangeMax: 100, label: 'X', resultText: 'x' }] },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.randomTable.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST .../tables is 400 for invalid dice notation', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Broken Dice',
          diceNotation: 'not-dice',
          rows: [{ rangeMin: 1, rangeMax: 100, label: 'X', resultText: 'x' }],
        },
      });
      expect(res.statusCode).toBe(400);
      const count = await prisma.randomTable.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST .../tables is 400 when the body fails zod validation (empty name)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '', rows: [{ rangeMin: 1, rangeMax: 100, label: 'X', resultText: 'x' }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST .../tables is 400 when rows is empty (min(1))', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tables`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'No Rows', rows: [] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/tables/:id -----------------------------------------

  it('the owner can delete their own table (200) and the row is gone', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const tableId = await makeTable(serverId, ownerId, { name: 'Doomed' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tables/${tableId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(tableId);
      const row = await prisma.randomTable.findUnique({ where: { id: tableId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a non-owner WITH MANAGE_CAMPAIGNS can delete someone else’s table (200)', async () => {
    const ownerId = await makeUser('owner');
    const tableOwnerId = await makeUser('tableowner');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_CAMPAIGNS);
    await addMember(serverId, tableOwnerId);
    const tableId = await makeTable(serverId, tableOwnerId, { name: 'Shared' });

    const app = await buildTestApp();
    try {
      // The server owner (holds every permission) deletes a table they don't own.
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tables/${tableId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.randomTable.findUnique({ where: { id: tableId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a non-owner WITHOUT MANAGE_CAMPAIGNS cannot delete a table (403), row survives', async () => {
    const ownerId = await makeUser('owner');
    const tableOwnerId = await makeUser('tableowner');
    const otherId = await makeUser('other');
    const { serverId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, tableOwnerId);
    await addMember(serverId, otherId);
    const tableId = await makeTable(serverId, tableOwnerId, { name: 'Protected' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(otherId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tables/${tableId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.randomTable.findUnique({ where: { id: tableId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/tables/:id is 404 for an unknown table', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tables/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/tables/:id/roll --------------------------------------

  it('rolls a fixed-notation table (200) and returns the matched row, no message when channelId omitted', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    // 1d1 always totals 1 → deterministically matches the [1,1] row.
    const tableId = await makeTable(serverId, ownerId, {
      diceNotation: '1d1',
      rows: [{ rangeMin: 1, rangeMax: 1, label: 'Certain', resultText: 'You always get this.' }],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/tables/${tableId}/roll`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<RollDto>;
      expect(body.data.tableId).toBe(tableId);
      expect(body.data.roll.total).toBe(1);
      expect(body.data.matchedRow?.label).toBe('Certain');
      expect(body.data.messageId).toBeNull();
      // No message persisted when channelId is absent.
      expect(await prisma.message.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rolling with channelId posts a dice_roll message into the channel (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServer(ownerId);
    const tableId = await makeTable(serverId, ownerId, {
      diceNotation: '1d1',
      rows: [{ rangeMin: 1, rangeMax: 1, label: 'Hit', resultText: 'A direct hit.' }],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/tables/${tableId}/roll`,
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<RollDto>;
      expect(body.data.messageId).not.toBeNull();
      const msg = await prisma.message.findUniqueOrThrow({ where: { id: body.data.messageId! } });
      expect(msg.channelId).toBe(channelId);
      expect(msg.type).toBe('dice_roll');
      expect(msg.authorId).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('rolling with channelId is 403 when the caller lacks SEND_MESSAGES in that channel', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServer(ownerId);
    // Withhold SEND_MESSAGES from @everyone (the default bitset includes it)
    // so a plain member cannot post the roll into the channel.
    await prisma.role.updateMany({
      where: { serverId, isEveryone: true },
      data: {
        permissions: new Prisma.Decimal(
          serializePermissions(PERMISSION_DEFAULT_EVERYONE & ~Permission.SEND_MESSAGES),
        ),
      },
    });
    await addMember(serverId, memberId);
    const tableId = await makeTable(serverId, ownerId, {
      diceNotation: '1d1',
      rows: [{ rangeMin: 1, rangeMax: 1, label: 'X', resultText: 'x' }],
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/tables/${tableId}/roll`,
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.message.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/tables/:id/roll is 404 for an unknown table', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/tables/${ulid()}/roll`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/tables/:id/roll without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/tables/${ulid()}/roll`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
