import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { APP_NAME } from '@tavern/shared';
import { type Config } from './config.js';
import { createLogger } from './lib/logger.js';
import { JwtService } from './lib/jwt.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthPlugin } from './plugins/auth.js';
import { AuthService } from './services/auth-service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerOverwriteRoutes } from './routes/overwrites.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerReactionRoutes } from './routes/reactions.js';
import { registerEmojiRoutes } from './routes/emojis.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerHandoutRoutes } from './routes/handouts.js';
import { registerDiceRoutes } from './routes/dice.js';
import { registerBoardGameRoutes } from './routes/board-games.js';
import { registerGameNightRoutes } from './routes/game-nights.js';
import { registerModerationRoutes } from './routes/moderation.js';
import { registerGateway } from './gateway/index.js';
import { ok } from './lib/responses.js';

export interface BuildAppOptions {
  config: Config;
  /** When true, skip route modules that need infra services (Phase 1+ tests). */
  authOnly?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  // pino's Logger interface is structurally compatible with FastifyBaseLogger
  // at runtime, but doesn't satisfy TypeScript's check. Cast through unknown.
  const app: FastifyInstance = Fastify({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loggerInstance: createLogger(opts.config.NODE_ENV) as any,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: opts.config.NODE_ENV === 'test',
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: opts.config.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    skipOnError: true,
  });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  registerErrorHandler(app);

  const jwt = new JwtService({
    accessSecret: opts.config.JWT_ACCESS_SECRET,
    refreshSecret: opts.config.JWT_REFRESH_SECRET,
    accessTtlSeconds: opts.config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: opts.config.REFRESH_TOKEN_TTL_SECONDS,
    issuer: opts.config.APP_NAME,
  });
  registerAuthPlugin(app, { jwt });

  const authService = new AuthService({ jwt, config: opts.config });

  app.get('/healthz', async () => ok({ ok: true, app: APP_NAME, env: opts.config.NODE_ENV }));
  app.get('/api/instance', async () =>
    ok({
      name: opts.config.APP_NAME,
      version: '0.0.0',
      features: {
        registrationOpen: opts.config.ALLOW_PUBLIC_REGISTRATION,
        trustSafetyCoreEnabled: opts.config.TRUST_SAFETY_CORE_ENABLED,
        unscannedUploadsAllowed: opts.config.ALLOW_UNSCANNED_UPLOADS,
        liveKitConfigured: Boolean(opts.config.LIVEKIT_URL),
      },
    }),
  );

  await registerAuthRoutes(app, { auth: authService, config: opts.config });

  if (!opts.authOnly) {
    await registerServerRoutes(app);
    await registerChannelRoutes(app);
    await registerMessageRoutes(app);
    await registerRoleRoutes(app);
    await registerOverwriteRoutes(app);
    await registerInviteRoutes(app);
    await registerUploadRoutes(app, opts.config);
    await registerReactionRoutes(app);
    await registerEmojiRoutes(app);
    await registerVoiceRoutes(app, opts.config);
    await registerCampaignRoutes(app);
    await registerSessionRoutes(app);
    await registerNoteRoutes(app);
    await registerHandoutRoutes(app);
    await registerDiceRoutes(app);
    await registerBoardGameRoutes(app);
    await registerGameNightRoutes(app);
    await registerModerationRoutes(app);
    registerGateway(app, jwt);
  }

  return app;
}
