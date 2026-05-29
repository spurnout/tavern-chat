/**
 * Integration coverage for the message-send nonce idempotency contract and
 * its IDOR guard (the fix that landed in the current branch).
 *
 * The `(channelId, nonce)` pair is unique DB-wide, so a nonce chosen by one
 * user collides with any other user's send that reuses it. Before the fix,
 * the route returned the existing row to whoever presented the nonce — letting
 * user B replay (and read) user A's message. The guard now requires the
 * existing row to belong to the *same author*, be a *main-room* message
 * (threadId null), and *not be deleted* before it will replay; otherwise it
 * 400s.
 *
 * What we lock in here (POST /api/channels/:id/messages):
 *   1. Same author + same nonce → 200, returns the SAME message, no second row.
 *   2. Different author + same nonce → 400 "Nonce already used", no second row,
 *      and the response never leaks the original author's content.
 *
 * Federation is off so the route never touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, serializePermissions, ulid } from '@tavern/shared';
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

/** Server with an @everyone role (default perms include SEND_MESSAGES) + a text channel. */
async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Nonce Tavern' } });
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

describe.skipIf(!dockerOk)('POST /api/channels/:id/messages — nonce idempotency + IDOR guard', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('same author replaying the same nonce gets the SAME message back (idempotent, no duplicate row)', async () => {
    const aliceId = await makeUser('alice');
    const { channelId } = await makeServerWithChannel(aliceId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const post = () =>
        app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: { content: 'hello once', nonce: 'NONCE-IDEMPOTENT' },
        });

      const first = await post();
      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as OkBody<{ id: string; content: string }>;

      const second = await post();
      // Replay returns the original message with 200 (not a fresh 201).
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as OkBody<{ id: string }>;
      expect(secondBody.data.id).toBe(firstBody.data.id);

      // Exactly one row persisted for the nonce.
      const count = await prisma.message.count({ where: { channelId, nonce: 'NONCE-IDEMPOTENT' } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('a different author reusing the same nonce is rejected (400) and cannot read the original', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);

    const app = await buildTestApp();
    try {
      const aliceToken = await mintToken(aliceId);
      const bobToken = await mintToken(bobId);

      const aliceRes = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${aliceToken}` },
        payload: { content: 'alice secret', nonce: 'SHARED-NONCE' },
      });
      expect(aliceRes.statusCode).toBe(201);

      const bobRes = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { content: 'bob attempt', nonce: 'SHARED-NONCE' },
      });
      // IDOR guard: Bob must NOT receive Alice's message; the route 400s.
      expect(bobRes.statusCode).toBe(400);
      expect(bobRes.body).not.toContain('alice secret');

      // Only Alice's single message exists for the nonce.
      const rows = await prisma.message.findMany({ where: { channelId, nonce: 'SHARED-NONCE' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.authorId).toBe(aliceId);
    } finally {
      await app.close();
    }
  });
});
