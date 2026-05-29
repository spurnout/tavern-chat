/**
 * Integration coverage for `apps/api/src/routes/tokens-webhooks.ts`
 * (Wave 2 #19 — API tokens, bot accounts, incoming webhooks).
 *
 * Endpoints exercised against a real Postgres (testcontainer) via
 * `app.inject`:
 *
 *   GET    /api/me/tokens                 list the caller's PATs
 *   POST   /api/me/tokens                 mint a PAT (plaintext returned once)
 *   DELETE /api/me/tokens/:id             revoke a PAT (ownership-scoped)
 *   POST   /api/servers/:id/bots          create a bot account (MANAGE_SERVER)
 *   GET    /api/channels/:id/webhooks     list channel webhooks (MANAGE_CHANNELS)
 *   POST   /api/channels/:id/webhooks     create a webhook (MANAGE_CHANNELS)
 *   DELETE /api/webhooks/:id              revoke a webhook (MANAGE_CHANNELS)
 *   POST   /api/webhooks/:id/messages     public delivery (secret-authed)
 *
 * For each we lock in the happy path plus the failure modes the handler
 * branches on: 401 (no/invalid token), 403 (member lacks MANAGE_* on a
 * server/channel they can otherwise see), 404 (not found / not owned), and
 * 400/409 (validation, duplicate username, bad webhook secret). DB
 * side-effects (ApiToken / Webhook / User / Message rows) are asserted
 * directly so we prove the route persisted what it claimed.
 *
 * Federation is off so no route here touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
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

/** Server with an @everyone role (default perms) + a text channel; owner is a member. */
async function makeServerWithChannel(
  ownerId: string,
): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Webhook Tavern' } });
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

async function addMember(serverId: string, userId: string, roleId?: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
  if (roleId) {
    await prisma.serverMemberRole.create({ data: { serverId, userId, roleId } });
  }
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

async function cleanup(): Promise<void> {
  await prisma.message.deleteMany({});
  await prisma.webhook.deleteMany({});
  await prisma.apiToken.deleteMany({});
  await prisma.serverMemberRole.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
}

// ============================================================================
// API tokens
// ============================================================================

describe.skipIf(!dockerOk)('tokens-webhooks: personal access tokens', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('POST /api/me/tokens mints a PAT, returns plaintext once, persists a hashed row', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const authToken = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { label: 'CI deploy key' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; label: string; token: string }>;
      expect(body.data.label).toBe('CI deploy key');
      // Plaintext is the tvn_pat_ format and returned exactly once.
      expect(body.data.token).toMatch(/^tvn_pat_/);

      // The DB stores the sha256 hash, never the plaintext.
      const row = await prisma.apiToken.findUnique({ where: { id: body.data.id } });
      expect(row).not.toBeNull();
      expect(row?.userId).toBe(userId);
      const expectedHash = crypto.createHash('sha256').update(body.data.token).digest('hex');
      expect(row?.tokenHash).toBe(expectedHash);
      // The list endpoint never exposes the hash/plaintext (asserted below).
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/tokens honours expiresAt and rejects an invalid label (400)', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const authToken = await mintToken(userId);
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const ok = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { label: 'expiring', expiresAt },
      });
      expect(ok.statusCode).toBe(201);
      const okBody = ok.json() as OkBody<{ id: string; expiresAt: string | null }>;
      expect(okBody.data.expiresAt).toBe(expiresAt);
      const row = await prisma.apiToken.findUnique({ where: { id: okBody.data.id } });
      expect(row?.expiresAt?.toISOString()).toBe(expiresAt);

      // Empty label fails the zod min(1) check.
      const bad = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { label: '' },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/tokens lists only the caller\'s tokens and never leaks the hash', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const app = await buildTestApp();
    try {
      const aliceAuth = await mintToken(aliceId);
      const bobAuth = await mintToken(bobId);
      // Alice mints a second, labelled token.
      await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${aliceAuth}` },
        payload: { label: 'second' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${aliceAuth}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; label: string }>>;
      // Alice has her bootstrap auth token + the freshly minted one = 2.
      expect(body.data).toHaveLength(2);
      // The serialized shape exposes metadata only — no token/tokenHash field.
      const serialized = JSON.stringify(body.data);
      expect(serialized).not.toContain('tokenHash');
      expect(serialized).not.toContain(bobAuth);
      expect(body.data.every((t) => typeof t.id === 'string')).toBe(true);

      // Bob sees only his single bootstrap token, not Alice's.
      const bobRes = await app.inject({
        method: 'GET',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${bobAuth}` },
      });
      const bobBody = bobRes.json() as OkBody<unknown[]>;
      expect(bobBody.data).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/tokens requires authentication (401)', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/tokens' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/tokens/:id revokes the caller\'s own token (sets revokedAt)', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const authToken = await mintToken(userId);
      const created = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { label: 'to-revoke' },
      });
      const { id } = (created.json() as OkBody<{ id: string }>).data;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/tokens/${id}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.apiToken.findUnique({ where: { id } });
      expect(row?.revokedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/tokens/:id 404s for someone else\'s token and leaves it intact', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const app = await buildTestApp();
    try {
      const aliceAuth = await mintToken(aliceId);
      const bobAuth = await mintToken(bobId);
      const created = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { authorization: `Bearer ${aliceAuth}` },
        payload: { label: 'alice-only' },
      });
      const { id } = (created.json() as OkBody<{ id: string }>).data;

      // Bob tries to revoke Alice's token — ownership guard returns 404
      // (existence isn't confirmed to a non-owner).
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/tokens/${id}`,
        headers: { authorization: `Bearer ${bobAuth}` },
      });
      expect(res.statusCode).toBe(404);
      const row = await prisma.apiToken.findUnique({ where: { id } });
      expect(row?.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/tokens/:id 404s for a non-existent token id', async () => {
    const userId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const authToken = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/tokens/${ulid()}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// Bot accounts
// ============================================================================

describe.skipIf(!dockerOk)('tokens-webhooks: bot accounts', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('POST /api/servers/:id/bots creates a bot user, joins it, and mints a bot token (admin)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, everyoneId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/bots`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { username: 'helper_bot', displayName: 'Helper Bot' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        bot: { id: string; username: string; displayName: string };
        token: string;
      }>;
      expect(body.data.bot.username).toBe('helper_bot');
      expect(body.data.token).toMatch(/^tvn_bot_/);

      // Bot user row exists, flagged isBot, with a fake email.
      const botId = body.data.bot.id;
      const botUser = await prisma.user.findUnique({ where: { id: botId } });
      expect(botUser?.isBot).toBe(true);
      expect(botUser?.email).toContain('@bots.invalid');

      // Joined the tavern with the @everyone role.
      const membership = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: botId } },
      });
      expect(membership).not.toBeNull();
      const roleLink = await prisma.serverMemberRole.findFirst({
        where: { serverId, userId: botId, roleId: everyoneId },
      });
      expect(roleLink).not.toBeNull();

      // An initial bot token was minted, hashed at rest.
      const botToken = await prisma.apiToken.findFirst({ where: { userId: botId } });
      expect(botToken).not.toBeNull();
      const expectedHash = crypto.createHash('sha256').update(body.data.token).digest('hex');
      expect(botToken?.tokenHash).toBe(expectedHash);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/bots 403s for a non-admin member', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId, everyoneId);
    const app = await buildTestApp();
    try {
      const memberAuth = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/bots`,
        headers: { authorization: `Bearer ${memberAuth}` },
        payload: { username: 'sneaky_bot', displayName: 'Sneaky' },
      });
      // @everyone lacks MANAGE_SERVER → 403.
      expect(res.statusCode).toBe(403);
      const botCount = await prisma.user.count({ where: { isBot: true } });
      expect(botCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/bots 409s when the username is taken', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    // Pre-existing user occupies the desired username (lowercased).
    await prisma.user.create({
      data: {
        id: ulid(),
        username: 'TakenName',
        usernameLower: 'takenname',
        displayName: 'Taken',
        email: 'taken@example.test',
        emailLower: 'taken@example.test',
        passwordHash: 'x',
      },
    });
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/bots`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { username: 'takenname', displayName: 'Dup' },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/bots 400s on an invalid username (regex / length)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/bots`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { username: 'bad name!', displayName: 'Nope' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/bots requires authentication (401)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/bots`,
        payload: { username: 'anon_bot', displayName: 'Anon' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// Webhooks (management)
// ============================================================================

describe.skipIf(!dockerOk)('tokens-webhooks: webhook management', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('POST /api/channels/:id/webhooks creates a webhook and returns the secret once (admin)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'CI announcer' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; secret: string; name: string }>;
      expect(body.data.name).toBe('CI announcer');
      expect(typeof body.data.secret).toBe('string');
      expect(body.data.secret.length).toBeGreaterThan(0);

      const row = await prisma.webhook.findUnique({ where: { id: body.data.id } });
      expect(row?.channelId).toBe(channelId);
      expect(row?.createdBy).toBe(ownerId);
      // Stored secret matches the one returned at creation.
      expect(row?.secret).toBe(body.data.secret);
    } finally {
      await app.close();
    }
  });

  it('POST /api/channels/:id/webhooks 403s for a non-admin member (lacks MANAGE_CHANNELS)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId, everyoneId);
    const app = await buildTestApp();
    try {
      const memberAuth = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${memberAuth}` },
        payload: { name: 'sneaky' },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.webhook.count({ where: { channelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/channels/:id/webhooks 400s on an empty name', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/webhooks lists active webhooks without the secret', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      // Create two webhooks; revoke one so we can assert it's filtered out.
      const a = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'keeper' },
      });
      const b = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'doomed' },
      });
      const revokedId = (b.json() as OkBody<{ id: string }>).data.id;
      void a;
      await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${revokedId}`,
        headers: { authorization: `Bearer ${ownerAuth}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; name: string }>>;
      // Only the non-revoked webhook is listed.
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.name).toBe('keeper');
      // The list shape never includes the secret.
      expect(JSON.stringify(body.data)).not.toContain('secret');
    } finally {
      await app.close();
    }
  });

  it('GET /api/channels/:id/webhooks 403s for a non-admin member', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId, everyoneId);
    const app = await buildTestApp();
    try {
      const memberAuth = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${memberAuth}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/webhooks/:id revokes a webhook (admin), then it stops listing', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'revoke-me' },
      });
      const { id } = (created.json() as OkBody<{ id: string }>).data;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${id}`,
        headers: { authorization: `Bearer ${ownerAuth}` },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.webhook.findUnique({ where: { id } });
      expect(row?.revokedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/webhooks/:id 404s for an unknown id', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${ulid()}`,
        headers: { authorization: `Bearer ${ownerAuth}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/webhooks/:id 403s for a non-admin member of the channel\'s server', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId, everyoneId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const memberAuth = await mintToken(memberId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'protected' },
      });
      const { id } = (created.json() as OkBody<{ id: string }>).data;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${id}`,
        headers: { authorization: `Bearer ${memberAuth}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.webhook.findUnique({ where: { id } });
      expect(row?.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// Public webhook delivery
// ============================================================================

describe.skipIf(!dockerOk)('tokens-webhooks: public webhook delivery', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('POST /api/webhooks/:id/messages with the right secret posts a message', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'Announcer' },
      });
      const { id, secret } = (created.json() as OkBody<{ id: string; secret: string }>).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}/messages?token=${encodeURIComponent(secret)}`,
        payload: { content: 'deploy finished' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ messageId: string }>;
      const msg = await prisma.message.findUnique({ where: { id: body.data.messageId } });
      expect(msg).not.toBeNull();
      expect(msg?.channelId).toBe(channelId);
      expect(msg?.serverId).toBe(serverId);
      // Posted under the webhook creator's identity, name-prefixed content.
      expect(msg?.authorId).toBe(ownerId);
      expect(msg?.content).toContain('Announcer');
      expect(msg?.content).toContain('deploy finished');

      // lastDeliveryAt was bumped.
      const wh = await prisma.webhook.findUnique({ where: { id } });
      expect(wh?.lastDeliveryAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:id/messages honours a username override in the prefix', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'DefaultName' },
      });
      const { id, secret } = (created.json() as OkBody<{ id: string; secret: string }>).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}/messages?token=${encodeURIComponent(secret)}`,
        payload: { content: 'hi', username: 'CustomBot' },
      });
      expect(res.statusCode).toBe(201);
      const { messageId } = (res.json() as OkBody<{ messageId: string }>).data;
      const msg = await prisma.message.findUnique({ where: { id: messageId } });
      expect(msg?.content).toContain('CustomBot');
      expect(msg?.content).not.toContain('DefaultName');
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:id/messages 401s on a wrong secret and posts nothing', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'Guarded' },
      });
      const { id, secret } = (created.json() as OkBody<{ id: string; secret: string }>).data;

      // Same length as the real secret but different bytes — exercises the
      // constant-time compare branch (length matches, content doesn't).
      const wrong = 'x'.repeat(secret.length);
      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}/messages?token=${encodeURIComponent(wrong)}`,
        payload: { content: 'should not land' },
      });
      expect(res.statusCode).toBe(401);
      const count = await prisma.message.count({ where: { channelId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:id/messages 401s when no token is supplied', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'NoToken' },
      });
      const { id } = (created.json() as OkBody<{ id: string }>).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}/messages`,
        payload: { content: 'no token here' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:id/messages 404s for an unknown webhook id', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${ulid()}/messages?token=anything`,
        payload: { content: 'into the void' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:id/messages 404s once the webhook is revoked', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'Ephemeral' },
      });
      const { id, secret } = (created.json() as OkBody<{ id: string; secret: string }>).data;
      await app.inject({
        method: 'DELETE',
        url: `/api/webhooks/${id}`,
        headers: { authorization: `Bearer ${ownerAuth}` },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}/messages?token=${encodeURIComponent(secret)}`,
        payload: { content: 'after revoke' },
      });
      // Revoked webhooks are treated as not-found (checked before the secret).
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/webhooks/:id/messages 400s on an empty content body', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerAuth = await mintToken(ownerId);
      const created = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: { authorization: `Bearer ${ownerAuth}` },
        payload: { name: 'Strict' },
      });
      const { id, secret } = (created.json() as OkBody<{ id: string; secret: string }>).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}/messages?token=${encodeURIComponent(secret)}`,
        payload: { content: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
