/**
 * PF-1 — per-user federation preferences.
 *
 * Coverage:
 *   1. Schema-level: fresh User row defaults `acceptsFederatedDms = true` and
 *      `acceptsFederatedPresence = true` (preserves pre-migration behaviour).
 *   2. Schema-level: prisma.user.update toggles both columns and round-trips.
 *   3. Route-level: GET /api/me/account returns both booleans.
 *   4. Route-level: PATCH /api/me/account with `{ acceptsFederatedDms: false }`
 *      round-trips and the DB row reflects the change. Same for presence.
 *   5. Route-level: PATCH /api/me/account ignores absent fields (no clobber).
 *
 * Docker-gated skip pattern matches the rest of the integration suite.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ulid } from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JwtService } from '../src/lib/jwt.js';

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

const SELF_HOST = 'self.example';

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

async function cleanDb(): Promise<void> {
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
}

async function makeUserWithToken(prefix: string): Promise<{
  userId: string;
  username: string;
  token: string;
}> {
  const userId = ulid();
  const sessionId = ulid();
  const username = `${prefix}-${userId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username,
      usernameLower: username,
      displayName: username,
      email: `${username}@${SELF_HOST}`,
      emailLower: `${username}@${SELF_HOST}`,
      passwordHash: 'x',
    },
  });
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const jwt = new JwtService({
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 7,
  });
  const { token } = await jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });
  return { userId, username, token };
}

// ─── Schema-level tests ───────────────────────────────────────────────────

describe.skipIf(!dockerOk)('PF-1 — schema defaults + round-trip', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('a fresh User row defaults both federation prefs to true', async () => {
    const userId = ulid();
    const username = `default-${userId.toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: userId,
        username,
        usernameLower: username,
        displayName: username,
        email: `${username}@${SELF_HOST}`,
        emailLower: `${username}@${SELF_HOST}`,
        passwordHash: 'x',
      },
    });
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        acceptsFederatedDms: true,
        acceptsFederatedPresence: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row!.acceptsFederatedDms).toBe(true);
    expect(row!.acceptsFederatedPresence).toBe(true);
  });

  it('flipping both columns to false round-trips through prisma', async () => {
    const userId = ulid();
    const username = `flip-${userId.toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: userId,
        username,
        usernameLower: username,
        displayName: username,
        email: `${username}@${SELF_HOST}`,
        emailLower: `${username}@${SELF_HOST}`,
        passwordHash: 'x',
      },
    });
    await prisma.user.update({
      where: { id: userId },
      data: {
        acceptsFederatedDms: false,
        acceptsFederatedPresence: false,
      },
    });
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        acceptsFederatedDms: true,
        acceptsFederatedPresence: true,
      },
    });
    expect(row!.acceptsFederatedDms).toBe(false);
    expect(row!.acceptsFederatedPresence).toBe(false);
  });
});

// ─── Route-level tests ────────────────────────────────────────────────────

describe.skipIf(!dockerOk)('PF-1 — GET/PATCH /api/me/account', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('GET returns both federation booleans with their defaults', async () => {
    const { token } = await makeUserWithToken('alice');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({
        acceptsFederatedDms: true,
        acceptsFederatedPresence: true,
      });
    } finally {
      await app.close();
    }
  });

  it('PATCH { acceptsFederatedDms: false } round-trips and DB row reflects change', async () => {
    const { userId, token } = await makeUserWithToken('bob');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
        payload: { acceptsFederatedDms: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.acceptsFederatedDms).toBe(false);
      // Untouched field stays true.
      expect(body.data.acceptsFederatedPresence).toBe(true);

      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          acceptsFederatedDms: true,
          acceptsFederatedPresence: true,
        },
      });
      expect(row!.acceptsFederatedDms).toBe(false);
      expect(row!.acceptsFederatedPresence).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH { acceptsFederatedPresence: false } round-trips and DB row reflects change', async () => {
    const { userId, token } = await makeUserWithToken('carol');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
        payload: { acceptsFederatedPresence: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.acceptsFederatedDms).toBe(true);
      expect(body.data.acceptsFederatedPresence).toBe(false);

      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          acceptsFederatedDms: true,
          acceptsFederatedPresence: true,
        },
      });
      expect(row!.acceptsFederatedDms).toBe(true);
      expect(row!.acceptsFederatedPresence).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('PATCH with both fields toggles both', async () => {
    const { userId, token } = await makeUserWithToken('dave');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          acceptsFederatedDms: false,
          acceptsFederatedPresence: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual({
        acceptsFederatedDms: false,
        acceptsFederatedPresence: false,
      });

      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          acceptsFederatedDms: true,
          acceptsFederatedPresence: true,
        },
      });
      expect(row!.acceptsFederatedDms).toBe(false);
      expect(row!.acceptsFederatedPresence).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('PATCH with empty body leaves both fields unchanged', async () => {
    const { userId, token } = await makeUserWithToken('erin');
    // Pre-seed: flip DMs off so we can prove the empty PATCH didn't touch it.
    await prisma.user.update({
      where: { id: userId },
      data: { acceptsFederatedDms: false },
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.acceptsFederatedDms).toBe(false);
      expect(body.data.acceptsFederatedPresence).toBe(true);
    } finally {
      await app.close();
    }
  });
});
