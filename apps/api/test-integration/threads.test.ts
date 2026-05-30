/**
 * Integration coverage for thread title handling on the thread routes.
 *
 * Thread titles are user-supplied free text. Message *content* is run through
 * sanitize-html server-side; titles must get the same treatment for parity
 * (defense-in-depth — titles are rendered as text today, but may surface in
 * other contexts or ship over federation later).
 *
 * Locked in here:
 *   1. POST /api/channels/:id/messages/:messageId/threads strips HTML from the
 *      title before persisting.
 *   2. PATCH /api/threads/:id strips HTML from a renamed title.
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

async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Thread Tavern' } });
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

describe.skipIf(!dockerOk)('thread title sanitization', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.thread.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  async function postRootMessage(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    token: string,
    channelId: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'root message' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as OkBody<{ id: string }>).data.id;
  }

  it('strips HTML from the title on thread create', async () => {
    const userId = await makeUser('host');
    const { channelId } = await makeServerWithChannel(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const rootId = await postRootMessage(app, token, channelId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/${rootId}/threads`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: '<img src=x onerror=alert(1)>Battle plan' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; title: string | null }>;
      expect(body.data.title).toBe('Battle plan');
      expect(body.data.title).not.toContain('<');

      const row = await prisma.thread.findUnique({ where: { id: body.data.id } });
      expect(row?.title).toBe('Battle plan');
    } finally {
      await app.close();
    }
  });

  it('strips HTML from the title on thread rename (PATCH)', async () => {
    const userId = await makeUser('host');
    const { channelId } = await makeServerWithChannel(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const rootId = await postRootMessage(app, token, channelId);

      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/${rootId}/threads`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Original' },
      });
      const threadId = (created.json() as OkBody<{ id: string }>).data.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${threadId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: '<b>Renamed</b>' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ title: string | null }>;
      expect(body.data.title).toBe('Renamed');
      expect(body.data.title).not.toContain('<');

      const row = await prisma.thread.findUnique({ where: { id: threadId } });
      expect(row?.title).toBe('Renamed');
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/threads/:id (single-thread fetch) -------------------------

  it('fetches a single thread by id (200) for a channel member', async () => {
    const userId = await makeUser('host');
    const { channelId } = await makeServerWithChannel(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const rootId = await postRootMessage(app, token, channelId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/${rootId}/threads`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'War council' },
      });
      const threadId = (created.json() as OkBody<{ id: string }>).data.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/threads/${threadId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; channelId: string; title: string | null }>;
      expect(body.data.id).toBe(threadId);
      expect(body.data.channelId).toBe(channelId);
      expect(body.data.title).toBe('War council');
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unknown thread id', async () => {
    const userId = await makeUser('host');
    await makeServerWithChannel(userId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/threads/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('denies a non-member fetching a thread (not 200)', async () => {
    const ownerId = await makeUser('host');
    const outsiderId = await makeUser('outsider');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const rootId = await postRootMessage(app, ownerToken, channelId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/${rootId}/threads`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { title: 'Private' },
      });
      const threadId = (created.json() as OkBody<{ id: string }>).data.id;

      const outsiderToken = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/threads/${threadId}`,
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      expect(res.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
});
