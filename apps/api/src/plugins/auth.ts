import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
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

  // Wave 2 #19 — API tokens for users and bot accounts. Tokens are prefixed
  // `tvn_pat_` (personal access tokens) or `tvn_bot_` (bot accounts) so we
  // can short-circuit before the JWT decode attempt and skip the session
  // table lookup (tokens are session-less).
  if (token.startsWith('tvn_pat_') || token.startsWith('tvn_bot_')) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const apiToken = await prisma.apiToken.findUnique({
      where: { tokenHash: hash },
      include: {
        user: { select: { id: true, isInstanceAdmin: true } },
      },
    });
    if (!apiToken || apiToken.revokedAt) {
      throw TavernError.unauthorized('Token is no longer valid');
    }
    if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
      throw TavernError.unauthorized('Token has expired');
    }
    // Fire-and-forget lastUsedAt bump so the token list reflects activity.
    void prisma.apiToken
      .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      userId: apiToken.user.id,
      // Synthetic session id — token auth has no Session row. Routes that
      // need to revoke "this session" should look up the API token instead.
      sessionId: `apitoken:${apiToken.id}`,
      isInstanceAdmin: apiToken.user.isInstanceAdmin,
    };
  }

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
