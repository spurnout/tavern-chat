/**
 * Integration coverage for the auth HTTP surface (apps/api/src/routes/auth.ts)
 * exercised end-to-end against a real Postgres testcontainer via `app.inject`.
 *
 * The unit suite (apps/api/test/auth.test.ts) drives the same routes with an
 * in-memory fake Prisma; this file instead lets the real AuthService logic run
 * against real rows so we lock in the DB side-effects the fake can't model:
 * the failed-login counter / lockout window, refresh-token rotation + replay
 * revocation, session revocation on logout, and the password-reset token
 * lifecycle (issue → consume → sibling invalidation).
 *
 * Branches covered here that the fake-Prisma unit tests do NOT reach:
 *   - login lockout: 10 consecutive failures set User.loginLockedUntil; a
 *     locked account is rejected before the password check; a success resets
 *     User.failedLoginAttempts to 0 and clears the lock.
 *   - refresh replay: presenting a revoked refresh token revokes EVERY active
 *     session for that user (reuse detection), not just the presented one.
 *   - refresh against an expired session → EXPIRED_TOKEN.
 *   - register branches: success consumes the invite (uses++), duplicate
 *     username (409 USERNAME_TAKEN), duplicate email (409 EMAIL_TAKEN),
 *     revoked / expired / fully-used invite (400 INVALID_INVITE), password
 *     policy (400 VALIDATION_ERROR).
 *   - logout sets Session.revokedAt.
 *   - password reset request + confirm: PasswordReset.usedAt is set, sessions
 *     are revoked, the token is single-use, and reusing the old password 400s.
 *
 * Federation is off so registration never touches the federation key store and
 * the queue overrides cover the (unused-here) outbound path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
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

const GOOD_PASSWORD = 'hunter22hunter22';

function envFor(dbUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    ...extra,
  } as NodeJS.ProcessEnv;
}

/**
 * Build the auth-only app. `authOnly: true` skips the non-auth routes (and the
 * federation key store), so AuthService runs without provisioning keypairs —
 * which is exactly the password-auth surface we want to exercise.
 *
 * `trustProxy` opts the app into honouring `X-Forwarded-For` for the
 * rate-limit key. The lockout test needs this: the login route is capped at
 * 10/min/IP, which is *below* the 10-failure account lockout threshold, so a
 * single-IP burst 429s before the threshold logic runs. Spreading the burst
 * across distinct forwarded IPs lets us exercise the per-account lockout
 * branch in the service (which keys on the account, not the IP) without the
 * route limiter pre-empting it.
 */
async function buildAuthApp(opts: { trustProxy?: boolean } = {}) {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(
      envFor(ctx!.databaseUrl, opts.trustProxy ? { TRUST_PROXY: 'true' } : {}),
    ),
    authOnly: true,
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

/**
 * Seed an instance-scoped invite (a registration ticket). `maxUses` defaults to
 * unlimited so most register tests don't accidentally exhaust it; pass a number
 * to exercise the fully-used branch.
 */
async function makeInstanceInvite(
  code: string,
  overrides: Partial<{
    maxUses: number | null;
    uses: number;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }> = {},
): Promise<string> {
  const id = ulid();
  await prisma.invite.create({
    data: {
      id,
      // The register schema uppercases inviteCode and the service looks the
      // invite up by that normalised form, so store the canonical (upper)
      // code regardless of how callers spell it.
      code: code.toUpperCase(),
      scope: 'instance',
      serverId: null,
      createdById: null,
      maxUses: overrides.maxUses ?? null,
      uses: overrides.uses ?? 0,
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    },
  });
  return id;
}

function registerPayload(over: Partial<Record<'username' | 'displayName' | 'email' | 'password' | 'inviteCode', string>>) {
  return {
    username: over.username ?? 'alice',
    displayName: over.displayName ?? 'Alice',
    email: over.email ?? 'alice@example.test',
    password: over.password ?? GOOD_PASSWORD,
    inviteCode: over.inviteCode ?? 'TEST-INVITE',
  };
}

type OkBody<T> = { ok: true; data: T };
type ErrBody = { ok: false; error: { code: string; message: string } };
type Tokens = { accessToken: string; refreshToken: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string };

const errCode = (res: { json: () => unknown }): string => (res.json() as ErrBody).error.code;
const tokensOf = (res: { json: () => unknown }): Tokens => (res.json() as OkBody<{ tokens: Tokens }>).data.tokens;

describe.skipIf(!dockerOk)('auth flows — integration (real Postgres + app.inject)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    // Order matters for FK constraints: child rows before parents.
    await prisma.passwordReset.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.invite.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // --------------------------------------------------------------------------
  // REGISTER
  // --------------------------------------------------------------------------
  describe('POST /api/auth/register', () => {
    it('creates a user + session and consumes the invite (uses++)', async () => {
      const inviteId = await makeInstanceInvite('TEST-INVITE', { maxUses: 5 });
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ username: 'alice', email: 'alice@example.test' }),
        });
        expect(res.statusCode).toBe(201);
        const tokens = tokensOf(res);
        expect(tokens.accessToken).toBeTruthy();
        expect(tokens.refreshToken).toBeTruthy();

        // User row created.
        const user = await prisma.user.findFirst({ where: { usernameLower: 'alice' } });
        expect(user).not.toBeNull();

        // Exactly one session for the new user, persisted, not revoked.
        const sessions = await prisma.session.findMany({ where: { userId: user!.id } });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.revokedAt).toBeNull();

        // Invite consumed exactly once.
        const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
        expect(invite?.uses).toBe(1);

        // httpOnly refresh cookie issued.
        const setCookie = res.headers['set-cookie'];
        const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
        expect(cookieHeader).toMatch(/tv_refresh=/);
      } finally {
        await app.close();
      }
    });

    it('rejects a duplicate username (409 USERNAME_TAKEN) and does not double-consume the invite', async () => {
      const inviteId = await makeInstanceInvite('TEST-INVITE', { maxUses: 10 });
      const app = await buildAuthApp();
      try {
        const first = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ username: 'alice', email: 'a1@example.test' }),
        });
        expect(first.statusCode).toBe(201);

        // Same username (case-insensitive), different email.
        const dup = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ username: 'ALICE', email: 'a2@example.test' }),
        });
        expect(dup.statusCode).toBe(409);
        expect(errCode(dup)).toBe('USERNAME_TAKEN');

        // Conflict is detected before the atomic consume → uses stays at 1.
        const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
        expect(invite?.uses).toBe(1);
        expect(await prisma.user.count()).toBe(1);
      } finally {
        await app.close();
      }
    });

    it('rejects a duplicate email (409 EMAIL_TAKEN)', async () => {
      await makeInstanceInvite('TEST-INVITE', { maxUses: 10 });
      const app = await buildAuthApp();
      try {
        const first = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ username: 'alice', email: 'shared@example.test' }),
        });
        expect(first.statusCode).toBe(201);

        const dup = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ username: 'bob', email: 'SHARED@example.test' }),
        });
        expect(dup.statusCode).toBe(409);
        expect(errCode(dup)).toBe('EMAIL_TAKEN');
      } finally {
        await app.close();
      }
    });

    it('rejects an unknown invite code (400 INVALID_INVITE)', async () => {
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ inviteCode: 'NO-SUCH-CODE' }),
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_INVITE');
        expect(await prisma.user.count()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('rejects a revoked invite (400 INVALID_INVITE)', async () => {
      await makeInstanceInvite('REVOKED-CODE', { revokedAt: new Date() });
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ inviteCode: 'REVOKED-CODE' }),
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_INVITE');
      } finally {
        await app.close();
      }
    });

    it('rejects an expired invite (400 INVALID_INVITE)', async () => {
      await makeInstanceInvite('EXPIRED-CODE', { expiresAt: new Date(Date.now() - 60_000) });
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ inviteCode: 'EXPIRED-CODE' }),
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_INVITE');
      } finally {
        await app.close();
      }
    });

    it('rejects a fully-used invite (400 INVALID_INVITE)', async () => {
      await makeInstanceInvite('USED-CODE', { maxUses: 1, uses: 1 });
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ inviteCode: 'USED-CODE' }),
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_INVITE');
        expect(await prisma.user.count()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('rejects a password shorter than the policy minimum (400 VALIDATION_ERROR)', async () => {
      await makeInstanceInvite('TEST-INVITE', { maxUses: 5 });
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ password: 'short' }), // < MIN_PASSWORD (8)
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('VALIDATION_ERROR');
        // Schema validation fires before the invite is touched.
        expect(await prisma.user.count()).toBe(0);
      } finally {
        await app.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // LOGIN  (incl. lockout)
  // --------------------------------------------------------------------------
  describe('POST /api/auth/login', () => {
    /** Register a fresh user through the real endpoint so the password hash is real. */
    async function seedUser(
      app: Awaited<ReturnType<typeof buildAuthApp>>,
      username: string,
      email: string,
    ): Promise<string> {
      await makeInstanceInvite(`INV-${username}`, { maxUses: 1 });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload({ username, email, inviteCode: `INV-${username}` }),
      });
      expect(res.statusCode).toBe(201);
      const user = await prisma.user.findFirstOrThrow({ where: { usernameLower: username } });
      return user.id;
    }

    it('returns tokens for valid credentials and leaves the failed-attempt counter at 0', async () => {
      const app = await buildAuthApp();
      try {
        const userId = await seedUser(app, 'loginok', 'loginok@example.test');
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'loginok', password: GOOD_PASSWORD },
        });
        expect(res.statusCode).toBe(200);
        expect(tokensOf(res).accessToken).toBeTruthy();

        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.failedLoginAttempts).toBe(0);
        expect(user.loginLockedUntil).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('returns 401 INVALID_CREDENTIALS for an unknown identifier', async () => {
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'ghost', password: GOOD_PASSWORD },
        });
        expect(res.statusCode).toBe(401);
        expect(errCode(res)).toBe('INVALID_CREDENTIALS');
      } finally {
        await app.close();
      }
    });

    it('returns 401 and increments failedLoginAttempts on a wrong password', async () => {
      const app = await buildAuthApp();
      try {
        const userId = await seedUser(app, 'wrongpw', 'wrongpw@example.test');
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'wrongpw', password: 'not-the-passwordxx' },
        });
        expect(res.statusCode).toBe(401);
        expect(errCode(res)).toBe('INVALID_CREDENTIALS');

        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.failedLoginAttempts).toBe(1);
        expect(user.loginLockedUntil).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('locks the account after 10 consecutive failures and keeps rejecting (lockout), then a correct password is still refused while locked', async () => {
      // trustProxy:true so each request can carry a distinct X-Forwarded-For —
      // the login route limiter is 10/min/IP, which would otherwise 429 the
      // 11th request before the per-account lockout (threshold 10) can be
      // observed. Lockout keys on the account, so spreading the burst across
      // IPs isolates the branch we're testing.
      const app = await buildAuthApp({ trustProxy: true });
      try {
        const userId = await seedUser(app, 'locked', 'locked@example.test');
        let ipCounter = 0;
        const badLogin = () =>
          app.inject({
            method: 'POST',
            url: '/api/auth/login',
            // Unique source IP per attempt → never trips the per-IP limiter.
            headers: { 'x-forwarded-for': `10.0.0.${(ipCounter += 1)}` },
            payload: { identifier: 'locked', password: 'definitely-wrongxx' },
          });

        // 10 failures → threshold reached → loginLockedUntil set.
        for (let i = 0; i < 10; i += 1) {
          const r = await badLogin();
          expect(r.statusCode).toBe(401);
          expect(errCode(r)).toBe('INVALID_CREDENTIALS');
        }
        let user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.failedLoginAttempts).toBe(10);
        expect(user.loginLockedUntil).not.toBeNull();
        expect(user.loginLockedUntil!.getTime()).toBeGreaterThan(Date.now());

        // A further attempt is rejected up front (still 401 INVALID_CREDENTIALS,
        // no 423/403 — the route reuses the credential error to avoid leaking
        // lock state). From a fresh IP so this is the lockout branch, not a 429.
        const locked = await badLogin();
        expect(locked.statusCode).toBe(401);
        expect(errCode(locked)).toBe('INVALID_CREDENTIALS');

        // Even the CORRECT password is refused while the lock window is open,
        // because the lock check runs before the hash comparison.
        const correctButLocked = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': `10.0.0.${(ipCounter += 1)}` },
          payload: { identifier: 'locked', password: GOOD_PASSWORD },
        });
        expect(correctButLocked.statusCode).toBe(401);
        expect(errCode(correctButLocked)).toBe('INVALID_CREDENTIALS');

        // The lock check returns before touching the counter, so it stays at 10.
        user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.failedLoginAttempts).toBe(10);
      } finally {
        await app.close();
      }
    });

    it('a successful login resets failedLoginAttempts to 0 and clears any lock', async () => {
      const app = await buildAuthApp();
      try {
        const userId = await seedUser(app, 'resetctr', 'resetctr@example.test');

        // Two failures (below threshold) leave the counter at 2, no lock.
        for (let i = 0; i < 2; i += 1) {
          const r = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { identifier: 'resetctr', password: 'wrong-passwordxx' },
          });
          expect(r.statusCode).toBe(401);
        }
        let user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.failedLoginAttempts).toBe(2);
        expect(user.loginLockedUntil).toBeNull();

        // A correct login clears the counter.
        const ok = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'resetctr', password: GOOD_PASSWORD },
        });
        expect(ok.statusCode).toBe(200);

        user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.failedLoginAttempts).toBe(0);
        expect(user.loginLockedUntil).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // REFRESH  (rotation + replay + expiry)
  // --------------------------------------------------------------------------
  describe('POST /api/auth/refresh', () => {
    async function registerAndGetTokens(
      app: Awaited<ReturnType<typeof buildAuthApp>>,
      username: string,
    ): Promise<Tokens> {
      await makeInstanceInvite(`INV-${username}`, { maxUses: 1 });
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload({ username, email: `${username}@example.test`, inviteCode: `INV-${username}` }),
      });
      expect(reg.statusCode).toBe(201);
      return tokensOf(reg);
    }

    it('rotates the refresh token: old session revoked, new session active', async () => {
      const app = await buildAuthApp();
      try {
        const t1 = await registerAndGetTokens(app, 'rotate');
        const userId = (await prisma.user.findFirstOrThrow({ where: { usernameLower: 'rotate' } })).id;

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: t1.refreshToken },
        });
        expect(res.statusCode).toBe(200);
        const t2 = tokensOf(res);
        expect(t2.refreshToken).not.toBe(t1.refreshToken);

        // Exactly one revoked (old) + one active (new) session.
        const sessions = await prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
        expect(sessions).toHaveLength(2);
        expect(sessions[0]?.revokedAt).not.toBeNull(); // rotated-out
        expect(sessions[1]?.revokedAt).toBeNull(); // freshly issued
      } finally {
        await app.close();
      }
    });

    it('replaying a rotated-out (revoked) refresh token is rejected (401 INVALID_TOKEN) and revokes ALL the user\'s sessions', async () => {
      const app = await buildAuthApp();
      try {
        const t1 = await registerAndGetTokens(app, 'replay');
        const userId = (await prisma.user.findFirstOrThrow({ where: { usernameLower: 'replay' } })).id;

        // First rotation succeeds, issuing t2 and revoking t1's session.
        const first = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: t1.refreshToken },
        });
        expect(first.statusCode).toBe(200);
        const t2 = tokensOf(first);

        // Replaying t1 (now revoked) trips reuse detection.
        const replay = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: t1.refreshToken },
        });
        expect(replay.statusCode).toBe(401);
        expect(errCode(replay)).toBe('INVALID_TOKEN');

        // Reuse detection revokes every active session — so even the legitimate
        // t2 issued by the first rotation is now dead.
        const active = await prisma.session.count({ where: { userId, revokedAt: null } });
        expect(active).toBe(0);

        const afterReplay = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: t2.refreshToken },
        });
        expect(afterReplay.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('rejects refresh against an expired session (401 EXPIRED_TOKEN)', async () => {
      const app = await buildAuthApp();
      try {
        const t1 = await registerAndGetTokens(app, 'expired');
        const session = await prisma.session.findFirstOrThrow({
          where: { user: { usernameLower: 'expired' } },
        });
        // Force the session past its expiry (token JWT itself is still valid;
        // the DB row is the authority for the session window).
        await prisma.session.update({
          where: { id: session.id },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: t1.refreshToken },
        });
        expect(res.statusCode).toBe(401);
        expect(errCode(res)).toBe('EXPIRED_TOKEN');
      } finally {
        await app.close();
      }
    });

    it('rejects refresh for an unknown / non-existent session (401 UNAUTHORIZED)', async () => {
      const app = await buildAuthApp();
      try {
        const t1 = await registerAndGetTokens(app, 'gone');
        // Delete the session row out from under a still-valid JWT.
        await prisma.session.deleteMany({ where: { user: { usernameLower: 'gone' } } });

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: t1.refreshToken },
        });
        expect(res.statusCode).toBe(401);
        expect(errCode(res)).toBe('UNAUTHORIZED');
      } finally {
        await app.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // LOGOUT
  // --------------------------------------------------------------------------
  describe('POST /api/auth/logout', () => {
    it('revokes the current session (Session.revokedAt set) and refresh of that token then fails', async () => {
      const app = await buildAuthApp();
      try {
        await makeInstanceInvite('INV-logout', { maxUses: 1 });
        const reg = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: registerPayload({ username: 'logout', email: 'logout@example.test', inviteCode: 'INV-logout' }),
        });
        expect(reg.statusCode).toBe(201);
        const tokens = tokensOf(reg);
        const userId = (await prisma.user.findFirstOrThrow({ where: { usernameLower: 'logout' } })).id;

        const before = await prisma.session.findFirstOrThrow({ where: { userId } });
        expect(before.revokedAt).toBeNull();

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as OkBody<{ ok: boolean }>).data.ok).toBe(true);

        const after = await prisma.session.findUniqueOrThrow({ where: { id: before.id } });
        expect(after.revokedAt).not.toBeNull();

        // The revoked session's refresh token is now reuse-detected.
        const refresh = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          payload: { refreshToken: tokens.refreshToken },
        });
        expect(refresh.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('requires authentication (401 without a token)', async () => {
      const app = await buildAuthApp();
      try {
        const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // PASSWORD RESET  (forgot → reset)
  // --------------------------------------------------------------------------
  describe('password reset (forgot-password + reset-password)', () => {
    async function registerUser(
      app: Awaited<ReturnType<typeof buildAuthApp>>,
      username: string,
      email: string,
    ): Promise<{ userId: string; tokens: Tokens }> {
      await makeInstanceInvite(`INV-${username}`, { maxUses: 1 });
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload({ username, email, inviteCode: `INV-${username}` }),
      });
      expect(reg.statusCode).toBe(201);
      const userId = (await prisma.user.findFirstOrThrow({ where: { usernameLower: username } })).id;
      return { userId, tokens: tokensOf(reg) };
    }

    it('forgot-password issues a single-use reset row for a known email (always 200)', async () => {
      const app = await buildAuthApp();
      try {
        const { userId } = await registerUser(app, 'forgot', 'forgot@example.test');

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/forgot-password',
          payload: { email: 'forgot@example.test' },
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as OkBody<{ ok: boolean }>).data.ok).toBe(true);

        const resets = await prisma.passwordReset.findMany({ where: { userId } });
        expect(resets).toHaveLength(1);
        expect(resets[0]?.usedAt).toBeNull();
        expect(resets[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      } finally {
        await app.close();
      }
    });

    it('forgot-password for an unknown email still returns 200 and creates no reset row (no enumeration)', async () => {
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/forgot-password',
          payload: { email: 'nobody@example.test' },
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as OkBody<{ ok: boolean }>).data.ok).toBe(true);
        expect(await prisma.passwordReset.count()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('reset-password consumes the token, rewrites the password, revokes sessions, and the new password logs in', async () => {
      const app = await buildAuthApp();
      try {
        const { userId } = await registerUser(app, 'doreset', 'doreset@example.test');

        // Mint a reset token directly so we hold the plaintext (the email body
        // is the only place it's surfaced in production; here we control the row).
        const { sha256 } = await import('../src/lib/hash.js');
        const plaintext = 'reset-token-plaintext-0123456789';
        await prisma.passwordReset.create({
          data: {
            id: ulid(),
            userId,
            tokenHash: sha256(plaintext),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });

        const newPassword = 'brandnewpass99';
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token: plaintext, newPassword },
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as OkBody<{ ok: boolean }>).data.ok).toBe(true);

        // Token consumed (single-use).
        const reset = await prisma.passwordReset.findFirstOrThrow({ where: { userId } });
        expect(reset.usedAt).not.toBeNull();

        // Every prior session revoked (the register session).
        expect(await prisma.session.count({ where: { userId, revokedAt: null } })).toBe(0);

        // Old password no longer works; new one does.
        const oldLogin = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'doreset', password: GOOD_PASSWORD },
        });
        expect(oldLogin.statusCode).toBe(401);

        const newLogin = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'doreset', password: newPassword },
        });
        expect(newLogin.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('reset-password rejects an already-used token (400 INVALID_RESET_TOKEN)', async () => {
      const app = await buildAuthApp();
      try {
        const { userId } = await registerUser(app, 'usedtok', 'usedtok@example.test');
        const { sha256 } = await import('../src/lib/hash.js');
        const plaintext = 'used-token-plaintext-0123456789';
        await prisma.passwordReset.create({
          data: {
            id: ulid(),
            userId,
            tokenHash: sha256(plaintext),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            usedAt: new Date(),
          },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token: plaintext, newPassword: 'anotherpass99' },
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_RESET_TOKEN');
      } finally {
        await app.close();
      }
    });

    it('reset-password rejects an expired token (400 INVALID_RESET_TOKEN)', async () => {
      const app = await buildAuthApp();
      try {
        const { userId } = await registerUser(app, 'exptok', 'exptok@example.test');
        const { sha256 } = await import('../src/lib/hash.js');
        const plaintext = 'expired-token-plaintext-012345678';
        await prisma.passwordReset.create({
          data: {
            id: ulid(),
            userId,
            tokenHash: sha256(plaintext),
            expiresAt: new Date(Date.now() - 60_000),
          },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token: plaintext, newPassword: 'anotherpass99' },
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_RESET_TOKEN');
      } finally {
        await app.close();
      }
    });

    it('reset-password rejects an unknown token (400 INVALID_RESET_TOKEN)', async () => {
      const app = await buildAuthApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token: 'totally-unknown-token-0123456789', newPassword: 'anotherpass99' },
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('INVALID_RESET_TOKEN');
      } finally {
        await app.close();
      }
    });

    it('reset-password refuses reusing the current password (400 VALIDATION_ERROR) and leaves the token unused', async () => {
      const app = await buildAuthApp();
      try {
        const { userId } = await registerUser(app, 'samepw', 'samepw@example.test');
        const { sha256 } = await import('../src/lib/hash.js');
        const plaintext = 'samepw-token-plaintext-0123456789';
        const resetId = ulid();
        await prisma.passwordReset.create({
          data: {
            id: resetId,
            userId,
            tokenHash: sha256(plaintext),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          // Same as the registration password → no-op reset, rejected.
          payload: { token: plaintext, newPassword: GOOD_PASSWORD },
        });
        expect(res.statusCode).toBe(400);
        expect(errCode(res)).toBe('VALIDATION_ERROR');

        // The no-op guard fires before the token is consumed.
        const reset = await prisma.passwordReset.findUniqueOrThrow({ where: { id: resetId } });
        expect(reset.usedAt).toBeNull();
      } finally {
        await app.close();
      }
    });
  });
});
