import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { APP_NAME } from '@tavern/shared';
import { ClamAVScanner } from '@tavern/media';
import { describeConfig, type Config } from './config.js';
import { createLogger } from './lib/logger.js';
import { JwtService } from './lib/jwt.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthPlugin } from './plugins/auth.js';
import { AuthService } from './services/auth-service.js';
import { createStorage } from './services/storage.js';
import { createQueueClient } from './services/queues.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerOverwriteRoutes } from './routes/overwrites.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerLocalFileRoutes } from './routes/local-files.js';
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
import { registerTypingRoutes } from './routes/typing.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerGateway } from './gateway/index.js';
import { initRedisBroker } from './services/gateway-broker.js';
import { ok } from './lib/responses.js';

export interface BuildAppOptions {
  config: Config;
  /** When true, skip route modules that need infra services (used by auth tests). */
  authOnly?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
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
        storageBackend: opts.config.STORAGE_BACKEND,
        liveKitConfigured: Boolean(opts.config.LIVEKIT_URL),
        scannerConfigured: Boolean(opts.config.CLAMAV_HOST),
        redisConfigured: Boolean(opts.config.REDIS_URL),
      },
    }),
  );

  await registerAuthRoutes(app, { auth: authService, config: opts.config });

  if (!opts.authOnly) {
    const storage = createStorage(opts.config);
    const scanner = opts.config.CLAMAV_HOST
      ? new ClamAVScanner({
          host: opts.config.CLAMAV_HOST,
          port: opts.config.CLAMAV_PORT,
        })
      : null;
    const queues = createQueueClient(opts.config, {
      storage,
      scanner,
      logger: app.log,
    });

    await registerServerRoutes(app);
    await registerChannelRoutes(app);
    await registerMessageRoutes(app);
    await registerRoleRoutes(app);
    await registerOverwriteRoutes(app);
    await registerInviteRoutes(app);
    await registerLocalFileRoutes(app, storage);
    await registerUploadRoutes(app, { config: opts.config, storage, queues });
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
    await registerTypingRoutes(app);
    await registerSearchRoutes(app);
    registerGateway(app, jwt);

    if (opts.config.NODE_ENV !== 'test' && opts.config.REDIS_URL) {
      void initRedisBroker(opts.config.REDIS_URL).catch((err) => {
        app.log.warn({ err }, 'redis broker init failed; staying in-process');
      });
    }

    // Bookkeeping: shut the queue down on close so dev restarts are clean.
    app.addHook('onClose', async () => {
      await queues.close().catch(() => undefined);
    });

    app.log.info(`tavern config:\n${describeConfig(opts.config)}`);
  }

  return app;
}
