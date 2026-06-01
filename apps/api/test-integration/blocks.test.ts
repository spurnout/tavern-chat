/**
 * Integration coverage for member blocking (`apps/api/src/routes/blocks.ts`)
 * and its enforcement in the DM-open path.
 *
 * Endpoints covered:
 *   GET    /api/users/me/blocks      — list my blocks (empty + populated)
 *   PUT    /api/users/:userId/block  — block; idempotent; 400 self-block; 404 absent
 *   DELETE /api/users/:userId/block  — unblock; idempotent
 *
 * Enforcement:
 *   POST   /api/dms/direct           — 403 when either party has blocked the other
 *   POST   /api/dms/group            — 403 when an invitee is in a block relationship
 *
 * Federation is off, so no outbound queue is touched.
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

async function makeServer(ownerId: string): Promise<string> {
  const serverId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Block Tavern' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return serverId;
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
const ABSENT_ID = ulid();

describe.skipIf(!dockerOk)('Member blocking', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.userBlock.deleteMany({});
    await prisma.dmChannelMember.deleteMany({});
    await prisma.dmChannel.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('rejects block endpoints with 401 when unauthenticated', async () => {
    const app = await buildTestApp();
    try {
      const calls: Array<[string, string]> = [
        ['GET', '/api/users/me/blocks'],
        ['PUT', `/api/users/${ABSENT_ID}/block`],
        ['DELETE', `/api/users/${ABSENT_ID}/block`],
      ];
      for (const [method, url] of calls) {
        const res = await app.inject({ method: method as 'GET', url, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('blocks, lists, and unblocks a member (idempotent both ways)', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const auth = { authorization: `Bearer ${token}` };

      // Initially empty.
      let res = await app.inject({ method: 'GET', url: '/api/users/me/blocks', headers: auth });
      expect((res.json() as OkBody<unknown[]>).data).toEqual([]);

      // Block bob (twice — idempotent).
      res = await app.inject({ method: 'PUT', url: `/api/users/${bob}/block`, headers: auth });
      expect(res.statusCode).toBe(200);
      res = await app.inject({ method: 'PUT', url: `/api/users/${bob}/block`, headers: auth });
      expect(res.statusCode).toBe(200);

      // Listed once.
      res = await app.inject({ method: 'GET', url: '/api/users/me/blocks', headers: auth });
      const list = (res.json() as OkBody<Array<{ userId: string }>>).data;
      expect(list.map((b) => b.userId)).toEqual([bob]);

      // Unblock (twice — idempotent).
      res = await app.inject({ method: 'DELETE', url: `/api/users/${bob}/block`, headers: auth });
      expect(res.statusCode).toBe(200);
      res = await app.inject({ method: 'DELETE', url: `/api/users/${bob}/block`, headers: auth });
      expect(res.statusCode).toBe(200);

      res = await app.inject({ method: 'GET', url: '/api/users/me/blocks', headers: auth });
      expect((res.json() as OkBody<unknown[]>).data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects self-block (400) and blocking an absent member (404)', async () => {
    const alice = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(alice);
      const auth = { authorization: `Bearer ${token}` };
      let res = await app.inject({ method: 'PUT', url: `/api/users/${alice}/block`, headers: auth });
      expect(res.statusCode).toBe(400);
      res = await app.inject({ method: 'PUT', url: `/api/users/${ABSENT_ID}/block`, headers: auth });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('refuses a direct DM when either party has blocked the other', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);
    const app = await buildTestApp();
    try {
      const aliceTok = await mintToken(alice);
      const bobTok = await mintToken(bob);

      // alice blocks bob.
      await app.inject({
        method: 'PUT',
        url: `/api/users/${bob}/block`,
        headers: { authorization: `Bearer ${aliceTok}` },
      });

      // alice -> bob refused (blocker side).
      let res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${aliceTok}` },
        payload: { userId: bob },
      });
      expect(res.statusCode).toBe(403);

      // bob -> alice also refused (blocked side can't reach the blocker).
      res = await app.inject({
        method: 'POST',
        url: '/api/dms/direct',
        headers: { authorization: `Bearer ${bobTok}` },
        payload: { userId: alice },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('refuses a group DM that includes a blocking invitee', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const serverId = await makeServer(alice);
    await addMember(serverId, bob);
    await addMember(serverId, carol);
    const app = await buildTestApp();
    try {
      const aliceTok = await mintToken(alice);
      // bob blocks alice.
      const bobTok = await mintToken(bob);
      await app.inject({
        method: 'PUT',
        url: `/api/users/${alice}/block`,
        headers: { authorization: `Bearer ${bobTok}` },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/dms/group',
        headers: { authorization: `Bearer ${aliceTok}` },
        payload: { userIds: [bob, carol] },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
