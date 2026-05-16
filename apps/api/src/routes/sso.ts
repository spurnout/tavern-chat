import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import type { OidcService } from '../services/oidc-service.js';
import type { AuthService } from '../services/auth-service.js';
import type { Config } from '../config.js';

interface SsoRouteOpts {
  oidc: OidcService;
  auth: AuthService;
  config: Config;
}

const REFRESH_COOKIE = 'tv_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * Wave 3 #36 — SSO via OIDC routes.
 *
 *   GET  /api/auth/sso/start              → redirect to IdP authorize URL
 *   GET  /api/auth/sso/callback?code=&state=  → exchange + issue session
 *   POST /api/me/sso/start                → linking flow (already authenticated)
 *   POST /api/me/sso/unlink               → drop the OIDC identity from this account
 */
export async function registerSsoRoutes(app: FastifyInstance, opts: SsoRouteOpts): Promise<void> {
  app.get('/api/auth/sso/start', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      if (!opts.oidc.isEnabled()) {
        throw new TavernError('INTERNAL_ERROR', 'SSO is not configured on this instance.', 503);
      }
      const url = await opts.oidc.buildAuthorizeUrl();
      reply.redirect(url);
    },
  });

  app.get('/api/auth/sso/callback', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = z
        .object({ code: z.string().min(1), state: z.string().min(1) })
        .parse(req.query);
      if (!opts.oidc.isEnabled()) {
        throw new TavernError('INTERNAL_ERROR', 'SSO is not configured.', 503);
      }
      const result = await opts.oidc.handleCallback(q.code, q.state);
      if (result.issuerLinkingMismatch) {
        // The user tried to link a different OIDC identity over an
        // already-linked account; reject cleanly.
        throw TavernError.forbidden(
          'This account is already linked to a different identity provider.',
        );
      }
      // Issue a Tavern session for the resolved user, same shape as
      // password-auth + WebAuthn login.
      const tokens = await opts.auth.issueWebauthnSession(result.userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        deviceName:
          typeof req.headers['x-device-name'] === 'string'
            ? (req.headers['x-device-name'] as string).slice(0, 200)
            : null,
      });
      const maxAgeSec = Math.max(
        1,
        Math.floor((new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / 1000),
      );
      reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
        httpOnly: true,
        secure: opts.config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: REFRESH_COOKIE_PATH,
        maxAge: maxAgeSec,
      });
      // Redirect back to the SPA root with the access token as a fragment
      // (NOT a query string — fragments don't go to servers / logs).
      const webBase = opts.config.WEB_BASE_URL.replace(/\/+$/, '');
      reply.redirect(
        `${webBase}/login?sso=1#access=${encodeURIComponent(tokens.accessToken)}&exp=${encodeURIComponent(tokens.accessTokenExpiresAt)}`,
      );
    },
  });

  app.post('/api/me/sso/start', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!opts.oidc.isEnabled()) {
      throw new TavernError('INTERNAL_ERROR', 'SSO is not configured.', 503);
    }
    const url = await opts.oidc.buildAuthorizeUrl({ linkingUserId: ctx.userId });
    reply.send(ok({ url }));
  });

  app.post('/api/me/sso/unlink', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    await opts.oidc.unlink(ctx.userId);
    reply.send(ok({ ok: true }));
  });
}
