import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import {
  bootstrapRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  TavernError,
  type BootstrapStatus,
  type Me,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import type { AuthService } from '../services/auth-service.js';
import type { Config } from '../config.js';

interface AuthRouteOpts {
  auth: AuthService;
  config: Config;
}

function clientContext(req: import('fastify').FastifyRequest) {
  return {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    deviceName: typeof req.headers['x-device-name'] === 'string' ? req.headers['x-device-name'] : null,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, opts: AuthRouteOpts): Promise<void> {
  // First-run check — frontend uses this to decide whether to redirect
  // unauthenticated users to /bootstrap or /login.
  app.get('/api/auth/bootstrap-status', async (_req, reply) => {
    const needsBootstrap = await opts.auth.needsBootstrap();
    const body: BootstrapStatus = { needsBootstrap };
    reply.send(ok(body));
  });

  // First-run bootstrap. Only succeeds while User.count = 0; further calls
  // get 409 CONFLICT.
  app.post('/api/auth/bootstrap', {
    config: { rateLimit: { max: 5, timeWindow: '5 minute' } },
    handler: async (req, reply) => {
      const body = bootstrapRequestSchema.parse(req.body);
      const tokens = await opts.auth.bootstrap(body, clientContext(req));
      reply.status(201).send(ok({ tokens }));
    },
  });

  app.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      if (!opts.config.ALLOW_PUBLIC_REGISTRATION) {
        // Allow registration only with a valid invite. (Service enforces this; flag is for UX.)
      }
      const body = registerRequestSchema.parse(req.body);
      const tokens = await opts.auth.register(body, clientContext(req));
      reply.status(201).send(ok({ tokens }));
    },
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = loginRequestSchema.parse(req.body);
      const tokens = await opts.auth.login(body, clientContext(req));
      reply.send(ok({ tokens }));
    },
  });

  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = refreshRequestSchema.parse(req.body);
      const tokens = await opts.auth.refresh(body.refreshToken, clientContext(req));
      reply.send(ok({ tokens }));
    },
  });

  app.post('/api/auth/logout', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      await opts.auth.logout(ctx.sessionId);
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
