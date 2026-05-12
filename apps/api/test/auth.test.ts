import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { ulid } from '@tavern/shared';
import { makeFakeDb, makeFakePrismaClient } from './helpers.js';

// We mock @tavern/db before importing buildApp so the in-memory client is used
// throughout the auth flows. The fakes are built inside vi.hoisted so they
// exist before vi.mock's factory runs (vitest hoists vi.mock to the top).
const hoisted = vi.hoisted(() => {
  // We can't import helpers here (vi.hoisted runs before module evaluation),
  // so we just allocate empty objects and fill them later from the test setup.
  const fakeDb: { users: Map<string, unknown>; sessions: Map<string, unknown>; invites: Map<string, unknown> } = {
    users: new Map(),
    sessions: new Map(),
    invites: new Map(),
  };
  return { fakeDb, fakePrismaRef: { current: null as unknown } };
});

vi.mock('@tavern/db', () => ({
  get prisma() {
    return hoisted.fakePrismaRef.current;
  },
  disconnectPrisma: async () => undefined,
}));

const fakeDb = makeFakeDb();
const fakePrisma = makeFakePrismaClient(fakeDb);
hoisted.fakeDb.users = fakeDb.users as unknown as Map<string, unknown>;
hoisted.fakeDb.sessions = fakeDb.sessions as unknown as Map<string, unknown>;
hoisted.fakeDb.invites = fakeDb.invites as unknown as Map<string, unknown>;
hoisted.fakePrismaRef.current = fakePrisma;

import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const TEST_CONFIG: Config = {
  APP_NAME: 'TavernTest',
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  PUBLIC_BASE_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  ACCESS_TOKEN_TTL_SECONDS: 60 * 15,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
  ALLOWED_ORIGINS: 'http://localhost:3030,http://localhost:3000',
  ALLOW_PUBLIC_REGISTRATION: false,
  TRUST_SAFETY_CORE_ENABLED: true,
  CLAMAV_HOST: 'localhost',
  CLAMAV_PORT: 3310,
  ALLOW_UNSCANNED_UPLOADS: false,
  BLOCK_EXECUTABLE_UPLOADS: true,
  BLOCK_ARCHIVE_UPLOADS: true,
  STRIP_IMAGE_METADATA: true,
  MAX_MESSAGE_LENGTH: 4000,
  // Storage config — auth tests use authOnly:true so the storage backend
  // never instantiates, but the schema still expects the defaults to parse.
  STORAGE_BACKEND: 'local',
  LOCAL_STORAGE_DIR: './data/storage',
  S3_ENDPOINT: undefined,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: undefined,
  S3_SECRET_KEY: undefined,
  S3_BUCKET: 'tavern-media',
  S3_QUARANTINE_BUCKET: 'tavern-quarantine',
  S3_USE_SSL: false,
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'devsecret-change-me',
};

async function makeApp() {
  return buildApp({ config: TEST_CONFIG, authOnly: true });
}

beforeEach(async () => {
  fakeDb.users.clear();
  fakeDb.sessions.clear();
  fakeDb.invites.clear();
  const inviteId = ulid();
  fakeDb.invites.set(inviteId, {
    id: inviteId,
    code: 'TEST-INVITE',
    scope: 'instance',
    serverId: null,
    channelId: null,
    createdById: null,
    maxUses: null,
    uses: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/auth/register', () => {
  it('rejects requests without an invite', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'NOPE',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: false; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_INVITE');
    await app.close();
  });

  it('creates a user and returns tokens', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { ok: true; data: { tokens: { accessToken: string; refreshToken: string } } };
    expect(body.ok).toBe(true);
    expect(body.data.tokens.accessToken).toBeTruthy();
    expect(body.data.tokens.refreshToken).toBeTruthy();
    expect(fakeDb.users.size).toBe(1);
    expect(fakeDb.sessions.size).toBe(1);
    expect(Array.from(fakeDb.invites.values())[0]?.uses).toBe(1);
    await app.close();
  });

  it('rejects duplicate usernames', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'alice',
        displayName: 'Alice',
        email: 'a1@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'ALICE',
        displayName: 'Alice2',
        email: 'a2@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USERNAME_TAKEN');
    await app.close();
  });
});

describe('GET /api/auth/bootstrap-status', () => {
  it('reports needsBootstrap=true when there are no users', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/bootstrap-status' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { needsBootstrap: boolean } }).data.needsBootstrap).toBe(true);
    await app.close();
  });

  it('reports needsBootstrap=false once a user exists', async () => {
    fakeDb.users.set('u1', {
      id: 'u1',
      username: 'someone',
      usernameLower: 'someone',
      displayName: 'Someone',
      email: 's@example.com',
      emailLower: 's@example.com',
      passwordHash: 'x',
      isInstanceAdmin: false,
      avatarAttachmentId: null,
      bio: null,
      postingLockedUntil: null,
      uploadsLockedUntil: null,
      failedLoginAttempts: 0,
      loginLockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/bootstrap-status' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { needsBootstrap: boolean } }).data.needsBootstrap).toBe(false);
    await app.close();
  });
});

describe('POST /api/auth/bootstrap (conflict)', () => {
  it('rejects when a user already exists', async () => {
    fakeDb.users.set('u1', {
      id: 'u1',
      username: 'someone',
      usernameLower: 'someone',
      displayName: 'Someone',
      email: 's@example.com',
      emailLower: 's@example.com',
      passwordHash: 'x',
      isInstanceAdmin: true,
      avatarAttachmentId: null,
      bio: null,
      postingLockedUntil: null,
      uploadsLockedUntil: null,
      failedLoginAttempts: 0,
      loginLockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: {
        username: 'admin',
        displayName: 'Admin',
        email: 'admin@example.com',
        password: 'hunter22hunter22',
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
    await app.close();
  });
});

describe('POST /api/auth/login', () => {
  it('returns 401 for unknown identifier', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'nobody', password: 'hunter22hunter22' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    await app.close();
  });

  it('logs in an existing user with correct password', async () => {
    fakeDb.users.set('u1', {
      id: 'u1',
      username: 'bob',
      usernameLower: 'bob',
      displayName: 'Bob',
      email: 'bob@example.com',
      emailLower: 'bob@example.com',
      passwordHash: await argon2.hash('correct-horse', { type: argon2.argon2id, memoryCost: 1 << 14, timeCost: 2, parallelism: 1 }),
      isInstanceAdmin: false,
      avatarAttachmentId: null,
      bio: null,
      postingLockedUntil: null,
      uploadsLockedUntil: null,
      failedLoginAttempts: 0,
      loginLockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'bob', password: 'correct-horse' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; data: { tokens: { accessToken: string } } };
    expect(body.data.tokens.accessToken).toBeTruthy();
    await app.close();
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns the user profile with a valid access token', async () => {
    const app = await makeApp();
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'cara',
        displayName: 'Cara',
        email: 'cara@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    const tokens = (reg.json() as { data: { tokens: { accessToken: string } } }).data.tokens;
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; data: { username: string } };
    expect(body.data.username).toBe('cara');
    await app.close();
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates refresh tokens and revokes the old one', async () => {
    const app = await makeApp();
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'dee',
        displayName: 'Dee',
        email: 'dee@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    const tokens1 = (reg.json() as { data: { tokens: { refreshToken: string } } }).data.tokens;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: tokens1.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const tokens2 = (res.json() as { data: { tokens: { refreshToken: string } } }).data.tokens;
    expect(tokens2.refreshToken).not.toBe(tokens1.refreshToken);

    // Re-using the original refresh token must now fail.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: tokens1.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    await app.close();
  });
});

describe('refresh-token cookie (SEC-001 / FE-02)', () => {
  it('sets an httpOnly tv_refresh cookie on register/login/refresh', async () => {
    const app = await makeApp();
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'eli',
        displayName: 'Eli',
        email: 'eli@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    expect(reg.statusCode).toBe(201);
    const setCookie = reg.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieHeader).toMatch(/tv_refresh=/);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Strict/i);
    expect(cookieHeader).toMatch(/Path=\/api\/auth/);
    await app.close();
  });

  it('accepts a refresh request that supplies the refresh token via cookie only', async () => {
    const app = await makeApp();
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'fae',
        displayName: 'Fae',
        email: 'fae@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'TEST-INVITE',
      },
    });
    const tokens1 = (reg.json() as { data: { tokens: { refreshToken: string } } }).data.tokens;

    // No body — token rides as a cookie only.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `tv_refresh=${tokens1.refreshToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const tokens2 = (res.json() as { data: { tokens: { refreshToken: string } } }).data.tokens;
    expect(tokens2.refreshToken).not.toBe(tokens1.refreshToken);
    await app.close();
  });

  it('refresh with neither cookie nor body returns 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    await app.close();
  });
});
