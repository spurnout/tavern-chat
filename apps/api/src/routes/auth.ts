import type { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '@tavern/db';
import {
  bootstrapRequestSchema,
  changePasswordRequestSchema,
  ErrorCodes,
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  TavernError,
  type BootstrapStatus,
  type Me,
  type TokenPair,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import type { AuthService } from '../services/auth-service.js';
import type { Config } from '../config.js';

interface AuthRouteOpts {
  auth: AuthService;
  config: Config;
}

const MAX_DEVICE_NAME_LENGTH = 200;

/**
 * Name of the httpOnly cookie that carries the refresh token. Scoped to
 * /api/auth so it is never sent to attachment downloads or the gateway
 * upgrade request (reduces accidental exposure surface).
 */
const REFRESH_COOKIE = 'tv_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

function clientContext(req: import('fastify').FastifyRequest) {
  const rawDevice = req.headers['x-device-name'];
  const deviceName =
    typeof rawDevice === 'string' ? rawDevice.slice(0, MAX_DEVICE_NAME_LENGTH) : null;
  return {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    deviceName,
  };
}

/**
 * Issue (or rotate) the refresh-token cookie. SameSite=Strict prevents the
 * browser from sending the cookie on any cross-site navigation, which is the
 * primary mitigation for both XSS-driven exfil (the token is unreadable from
 * JS) and CSRF (no third-party site can trigger /api/auth/refresh).
 */
function setRefreshCookie(reply: FastifyReply, tokens: TokenPair, config: Config): void {
  const maxAgeSec = Math.max(
    1,
    Math.floor((new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / 1000),
  );
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSec,
  });
}

function clearRefreshCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}

export async function registerAuthRoutes(app: FastifyInstance, opts: AuthRouteOpts): Promise<void> {
  // First-run check — frontend uses this to decide whether to redirect
  // unauthenticated users to /bootstrap or /login. Rate-limited because it
  // is unauthenticated and a tight loop can probe instance state cheaply
  // (SEC-004).
  app.get('/api/auth/bootstrap-status', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const needsBootstrap = await opts.auth.needsBootstrap();
      const body: BootstrapStatus = { needsBootstrap };
      reply.send(ok(body));
    },
  });

  // First-run bootstrap. Only succeeds while User.count = 0; further calls
  // get 409 CONFLICT.
  app.post('/api/auth/bootstrap', {
    config: { rateLimit: { max: 5, timeWindow: '5 minute' } },
    handler: async (req, reply) => {
      const body = bootstrapRequestSchema.parse(req.body);
      const tokens = await opts.auth.bootstrap(body, clientContext(req));
      setRefreshCookie(reply, tokens, opts.config);
      reply.status(201).send(ok({ tokens }));
    },
  });

  app.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      // The schema requires inviteCode unconditionally and the service
      // validates it, so registration is currently invite-only regardless
      // of ALLOW_PUBLIC_REGISTRATION. The flag is exposed via /api/instance
      // so the frontend can hide UI affordances; lifting the invite gate
      // would mean making inviteCode optional here and in the service.
      const body = registerRequestSchema.parse(req.body);
      const tokens = await opts.auth.register(body, clientContext(req));
      setRefreshCookie(reply, tokens, opts.config);
      reply.status(201).send(ok({ tokens }));
    },
  });

  app.post('/api/auth/login', {
    // SEC-007: 10/min/IP (was 20). Credential stuffing typically needs >10/min
    // to be cost-effective; this combined with the per-account lockout
    // (SEC-006) makes both online distributed and online targeted attacks
    // expensive. The fastify-rate-limit default keying uses req.ip, which
    // respects `trustProxy` (already configured).
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = loginRequestSchema.parse(req.body);
      const tokens = await opts.auth.login(body, clientContext(req));
      setRefreshCookie(reply, tokens, opts.config);
      reply.send(ok({ tokens }));
    },
  });

  app.post('/api/auth/refresh', {
    // SEC-020: 20/min/IP. A well-behaved client refreshes a handful of times
    // an hour (the access token TTL is 15 minutes by default). Anything
    // above that is either a runaway loop or a token-grinding attack.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      // Refresh token sources, in order:
      //   1. tv_refresh httpOnly cookie (current, SEC-001 / FE-02)
      //   2. body.refreshToken (deprecation runway for one release; tests)
      const body = refreshRequestSchema.parse(req.body ?? {});
      const cookieToken = req.cookies?.[REFRESH_COOKIE];
      const refreshToken = cookieToken ?? body.refreshToken;
      if (!refreshToken) {
        throw new TavernError(ErrorCodes.UNAUTHORIZED, 'No refresh token supplied', 401);
      }
      const tokens = await opts.auth.refresh(refreshToken, clientContext(req));
      setRefreshCookie(reply, tokens, opts.config);
      reply.send(ok({ tokens }));
    },
  });

  app.post('/api/auth/logout', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      await opts.auth.logout(ctx.sessionId);
      clearRefreshCookie(reply, opts.config);
      reply.send(ok({ ok: true }));
    },
  });

  // Change-password while logged in. Revokes every active session including
  // the current one, forcing re-login (SEC-003).
  app.patch('/api/auth/password', {
    config: { rateLimit: { max: 5, timeWindow: '5 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const body = changePasswordRequestSchema.parse(req.body);
      await opts.auth.changePassword(ctx.userId, body.currentPassword, body.newPassword);
      reply.send(ok({ ok: true }));
    },
  });

  app.get('/api/auth/me', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          avatarAttachmentId: true,
          bio: true,
          isInstanceAdmin: true,
          postingLockedUntil: true,
          uploadsLockedUntil: true,
          createdAt: true,
        },
      });
      if (!user) throw TavernError.notFound('User not found');
      const me: Me = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        avatarAttachmentId: user.avatarAttachmentId,
        bio: user.bio,
        isInstanceAdmin: user.isInstanceAdmin,
        postingLockedUntil: user.postingLockedUntil?.toISOString() ?? null,
        uploadsLockedUntil: user.uploadsLockedUntil?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
      };
      reply.send(ok(me));
    },
  });
}
