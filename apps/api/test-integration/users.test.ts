/**
 * Integration coverage for the user-profile surface in
 * `apps/api/src/routes/users.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Routes under test:
 *   GET  /api/users/:userId/profile
 *   PATCH /api/users/me/profile
 *
 * Auth / access model:
 *   - Both handlers require a valid token (→ 401 without one).
 *   - GET self: always allowed.
 *   - GET other user: caller and target must share a server; if they don't,
 *     the handler returns 404 (privacy: does not disclose whether userId exists).
 *   - GET non-existent userId: returns 404 (after share-server check).
 *   - PATCH: callers can only update their own profile (the endpoint is
 *     /api/users/me/profile so there is no "other-user" variant); bad field
 *     values (invalid timezone, too-long bio, bad accentColor) → 400.
 *   - Mutual servers: GET by viewer who shares a server with target returns
 *     that server in the mutualServers array.
 *
 * Fixtures: individual users, optionally joined to a shared server via the
 * minimal server + @everyone role setup used in other integration suites.
 * Federation is off (no outbound queue calls).
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

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

/** Minimal server owned by `ownerId` with @everyone role so that permission
 *  checks work, plus the owner enrolled as a member. */
async function makeSharedServer(ownerId: string, otherUserId: string): Promise<string> {
  const serverId = ulid();
  const everyoneId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Mutual Tavern' } });
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
  // We need at least one channel for a valid server, but users.ts doesn't
  // require it — skip for brevity.
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  await prisma.serverMember.create({ data: { serverId, userId: otherUserId } });
  return serverId;
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
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('user-profile routes (apps/api/src/routes/users.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // =========================================================================
  // GET /api/users/:userId/profile
  // =========================================================================

  it('a user can fetch their own profile (200, mutualServers is empty)', async () => {
    const userId = await makeUser('self');

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/${userId}/profile`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        id: string;
        username: string;
        displayName: string;
        bio: string | null;
        presence: string;
        pronouns: string | null;
        accentColor: string | null;
        timezone: string | null;
        customStatus: string | null;
        customStatusExpiresAt: string | null;
        socialLinks: unknown[];
        mutualServers: unknown[];
        createdAt: string;
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(userId);
      expect(body.data.mutualServers).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a user can fetch another user\'s profile when they share a server (200)', async () => {
    const viewerId = await makeUser('viewer');
    const targetId = await makeUser('target');
    await makeSharedServer(viewerId, targetId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/${targetId}/profile`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; mutualServers: Array<{ id: string; name: string }> }>;
      expect(body.data.id).toBe(targetId);
      // They share a server so mutualServers is non-empty
      expect(body.data.mutualServers.length).toBe(1);
      expect(body.data.mutualServers[0].name).toBe('Mutual Tavern');
    } finally {
      await app.close();
    }
  });

  it('fetching a user\'s profile returns 404 when the caller does not share a server', async () => {
    const viewerId = await makeUser('viewer');
    const targetId = await makeUser('target');
    // No shared server — usersShareServer returns false

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/${targetId}/profile`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET profile returns 404 for a completely unknown userId (even when caller is in a server)', async () => {
    const viewerId = await makeUser('viewer');
    const targetId = await makeUser('target');
    await makeSharedServer(viewerId, targetId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(viewerId);
      // A well-formed ULID that doesn't correspond to any user
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/${ulid()}/profile`,
        headers: { authorization: `Bearer ${token}` },
      });
      // Unknown userId → usersShareServer returns false → 404
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET profile returns 401 without a token', async () => {
    const targetId = await makeUser('target');
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/${targetId}/profile`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('fetching own profile returns all rich-profile fields populated after a PATCH', async () => {
    const userId = await makeUser('rich');

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);

      // First update the profile
      await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          displayName: 'Rich User',
          bio: 'A test bio',
          pronouns: 'they/them',
          accentColor: '#ff5500',
          timezone: 'America/New_York',
          customStatus: 'Testing',
        },
      });

      // Then fetch the profile and verify fields round-trip
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/${userId}/profile`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        displayName: string;
        bio: string | null;
        pronouns: string | null;
        accentColor: string | null;
        timezone: string | null;
        customStatus: string | null;
      }>;
      expect(body.data.displayName).toBe('Rich User');
      expect(body.data.bio).toBe('A test bio');
      expect(body.data.pronouns).toBe('they/them');
      expect(body.data.accentColor).toBe('#ff5500');
      expect(body.data.timezone).toBe('America/New_York');
      expect(body.data.customStatus).toBe('Testing');
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // PATCH /api/users/me/profile
  // =========================================================================

  it('PATCH /api/users/me/profile updates own profile (200) and DB row reflects changes', async () => {
    const userId = await makeUser('patcher');

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Updated Name', bio: 'New bio' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        id: string;
        displayName: string;
        bio: string | null;
        mutualServers: unknown[];
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(userId);
      expect(body.data.displayName).toBe('Updated Name');
      expect(body.data.bio).toBe('New bio');
      // PATCH self-fetch: mutualServers is absent from the serializer call
      // (no second arg), but serializeUserProfile defaults it to []
      expect(body.data.mutualServers).toEqual([]);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.displayName).toBe('Updated Name');
      expect(row.bio).toBe('New bio');
    } finally {
      await app.close();
    }
  });

  it('PATCH partial update: only sent fields change, others stay intact', async () => {
    const userId = await makeUser('partial');

    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);

      // Set initial values
      await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Initial', bio: 'Initial bio', pronouns: 'he/him' },
      });

      // Partial update: only change bio
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { bio: 'Changed bio' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        displayName: string;
        bio: string | null;
        pronouns: string | null;
      }>;
      expect(body.data.displayName).toBe('Initial');
      expect(body.data.bio).toBe('Changed bio');
      expect(body.data.pronouns).toBe('he/him');
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        payload: { displayName: 'Anon' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 400 for an invalid timezone', async () => {
    const userId = await makeUser('tz-bad');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { timezone: 'Not/A/Real/Timezone' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 400 for an invalid accentColor (not hex)', async () => {
    const userId = await makeUser('color-bad');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { accentColor: 'not-a-color' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 400 when bio exceeds 500 chars', async () => {
    const userId = await makeUser('bio-bad');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { bio: 'x'.repeat(501) },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH allows clearing nullable fields by sending null', async () => {
    const userId = await makeUser('nullable');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);

      // Set a bio first
      await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { bio: 'Has a bio', customStatus: 'Online and busy' },
      });

      // Clear them both
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { bio: null, customStatus: null },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ bio: string | null; customStatus: string | null }>;
      expect(body.data.bio).toBeNull();
      expect(body.data.customStatus).toBeNull();

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.bio).toBeNull();
      expect(row.customStatus).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('PATCH allows setting customStatusExpiresAt and the DB row reflects it', async () => {
    const userId = await makeUser('expires');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { customStatus: 'In a meeting', customStatusExpiresAt: expiresAt },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        customStatus: string | null;
        customStatusExpiresAt: string | null;
      }>;
      expect(body.data.customStatus).toBe('In a meeting');
      expect(body.data.customStatusExpiresAt).not.toBeNull();

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.customStatusExpiresAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('PATCH allows clearing customStatusExpiresAt by sending null', async () => {
    const userId = await makeUser('clears-expiry');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

      // Set first
      await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { customStatusExpiresAt: expiresAt },
      });

      // Clear
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { customStatusExpiresAt: null },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ customStatusExpiresAt: string | null }>;
      expect(body.data.customStatusExpiresAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('PATCH accepts valid socialLinks array and round-trips them', async () => {
    const userId = await makeUser('social');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const links = [
        { label: 'GitHub', url: 'https://github.com/example' },
        { label: 'Email', url: 'mailto:test@example.com' },
      ];
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { socialLinks: links },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        socialLinks: Array<{ label: string; url: string }>;
      }>;
      expect(body.data.socialLinks).toHaveLength(2);
      expect(body.data.socialLinks[0].label).toBe('GitHub');
      expect(body.data.socialLinks[1].label).toBe('Email');
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 400 for a socialLink with an unsafe protocol (javascript:)', async () => {
    const userId = await makeUser('xss');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          socialLinks: [{ label: 'XSS', url: 'javascript:alert(1)' }],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH returns 400 when socialLinks array exceeds 5 items', async () => {
    const userId = await makeUser('too-many-links');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const links = Array.from({ length: 6 }, (_, i) => ({
        label: `Link ${i}`,
        url: `https://example.com/${i}`,
      }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { socialLinks: links },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH a valid IANA timezone is accepted (200)', async () => {
    const userId = await makeUser('tz-good');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: { timezone: 'Europe/Paris' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ timezone: string | null }>;
      expect(body.data.timezone).toBe('Europe/Paris');
    } finally {
      await app.close();
    }
  });

  it('PATCH an empty body (no fields) is accepted (200, nothing changes)', async () => {
    const userId = await makeUser('noop');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/me/profile`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(userId);
    } finally {
      await app.close();
    }
  });
});
