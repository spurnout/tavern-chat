import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TavernError } from '@tavern/shared';
import { prisma } from '@tavern/db';
import type { JwtService } from '../lib/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  isInstanceAdmin: boolean;
}

interface AuthPluginOpts {
  jwt: JwtService;
}

export function registerAuthPlugin(app: FastifyInstance, opts: AuthPluginOpts): void {
  app.decorate(
    'requireUser',
    async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<AuthContext> {
      const ctx = await tryAuthenticate(req, opts.jwt);
      if (!ctx) throw TavernError.unauthorized();
      req.auth = ctx;
      return ctx;
    },
  );

  app.decorate(
    'optionalUser',
    async function optionalUser(req: FastifyRequest): Promise<AuthContext | null> {
      const ctx = await tryAuthenticate(req, opts.jwt);
      if (ctx) req.auth = ctx;
      return ctx;
    },
  );
}

async function tryAuthenticate(
  req: FastifyRequest,
  jwt: JwtService,
): Promise<AuthContext | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;

  const payload = await jwt.verifyAccess(token);

  // Verify the session still exists & is not revoked.
  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw TavernError.unauthorized('Session is no longer valid');
  }
  if (session.userId !== payload.sub) {
    throw TavernError.unauthorized('Session/user mismatch');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, isInstanceAdmin: true },
  });
  if (!user) throw TavernError.unauthorized('User not found');

  return {
    userId: user.id,
    sessionId: session.id,
    isInstanceAdmin: user.isInstanceAdmin,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthContext>;
    optionalUser: (req: FastifyRequest) => Promise<AuthContext | null>;
  }
}
