import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import {
  idSchema,
  TavernError,
  webauthnLoginFinishSchema,
  webauthnLoginStartSchema,
  webauthnRegisterFinishSchema,
  webauthnRegisterStartSchema,
} from '@tavern/shared';
import { z } from 'zod';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { ok } from '../lib/responses.js';
import type { WebAuthnService } from '../services/webauthn-service.js';
import {
  type AuthService,
  signStagedTotpToken,
  verifyStagedTotpToken,
} from '../services/auth-service.js';
import type { Config } from '../config.js';

interface WebAuthnRouteOpts {
  webauthn: WebAuthnService;
  auth: AuthService;
  config: Config;
}

/**
 * Wave 3 — WebAuthn / passkey endpoints.
 *
 * Enrollment is authenticated (the caller already knows who they are and is
 * adding a credential to their own account). Login start/finish are
 * anonymous; identification happens through the `identifier` body field and
 * the staged token issued by /login-start.
 */
export async function registerWebauthnRoutes(
  app: FastifyInstance,
  opts: WebAuthnRouteOpts,
): Promise<void> {
  // ---- Management ------------------------------------------------------

  app.get('/api/me/webauthn/credentials', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await opts.webauthn.list(ctx.userId);
    reply.send(ok(rows));
  });

  app.delete('/api/me/webauthn/credentials/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await opts.webauthn.remove(ctx.userId, id);
    reply.send(ok({ id }));
  });

  // ---- Enrollment ceremony --------------------------------------------

  app.post('/api/me/webauthn/register/options', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      // Body is optional — deviceName is only used at finish-time.
      webauthnRegisterStartSchema.parse(req.body ?? {});
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: ctx.userId },
        select: { username: true, displayName: true },
      });
      const options = await opts.webauthn.startRegistration(
        ctx.userId,
        user.username,
        user.displayName,
      );
      reply.send(ok(options));
    },
  });

  app.post('/api/me/webauthn/register/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const body = webauthnRegisterFinishSchema.parse(req.body);
      const row = await opts.webauthn.finishRegistration(
        ctx.userId,
        body.response as RegistrationResponseJSON,
        body.deviceName ?? null,
      );
      reply.send(ok(row));
    },
  });

  // ---- Login ceremony (anonymous) -------------------------------------

  app.post('/api/auth/login/webauthn/options', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = webauthnLoginStartSchema.parse(req.body);
      const identifierLower = body.identifier.trim().toLowerCase();
      // Look up the user, but DO NOT leak existence: always issue a staged
      // token + a (possibly empty) challenge. An attacker probing usernames
      // gets identical responses for "real account with no passkey" and
      // "unknown account".
      const user = await prisma.user.findFirst({
        where: {
          OR: [{ usernameLower: identifierLower }, { emailLower: identifierLower }],
        },
        select: { id: true },
      });
      const userId = user?.id ?? identifierLower;
      const { options, hasCredentials } = await opts.webauthn.startAuthentication(userId);
      // Stage a token bound to the resolved (or fake) user id so verify-step
      // doesn't have to be told it again — and so a leaked staged token
      // can't be reused against a different account.
      const stagedToken = signStagedTotpToken(userId, opts.config.JWT_ACCESS_SECRET);
      reply.send(ok({ stagedToken, options, hasCredentials }));
    },
  });

  app.post('/api/auth/login/webauthn/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = webauthnLoginFinishSchema.parse(req.body);
      const userId = verifyStagedTotpToken(body.stagedToken, opts.config.JWT_ACCESS_SECRET);
      if (!userId) {
        throw TavernError.unauthorized('Staged token invalid or expired');
      }
      const result = await opts.webauthn.finishAuthentication(
        userId,
        body.response as AuthenticationResponseJSON,
      );
      const tokens = await opts.auth.issueWebauthnSession(result.userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        deviceName:
          typeof req.headers['x-device-name'] === 'string'
            ? (req.headers['x-device-name'] as string).slice(0, 200)
            : null,
      });
      reply.send(ok({ tokens }));
    },
  });
}
