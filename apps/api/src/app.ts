import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { APP_NAME } from '@tavern/shared';
import { ClamAVScanner } from '@tavern/media';
import { describeConfig, type Config } from './config.js';
import { createLogger } from './lib/logger.js';
import { JwtService } from './lib/jwt.js';
import { setPasswordLogger } from './lib/passwords.js';
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
import { registerBanRoutes } from './routes/bans.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerLocalFileRoutes } from './routes/local-files.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
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
  // SEC-017: trustProxy defaults true in production (we run behind Traefik per
  // docs/deployment.md) and false in dev/test (where the API is hit directly
  // and spoofed X-Forwarded-For headers must not move the rate-limit key).
  const trustProxy =
    opts.config.TRUST_PROXY !== undefined
      ? opts.config.TRUST_PROXY
      : opts.config.NODE_ENV === 'production';
  const app: FastifyInstance = Fastify({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loggerInstance: createLogger(opts.config.NODE_ENV) as any,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy,
    // SEC-013: request logging is on in production by default and suppressed
    // in the test runner where it would drown the assertion output. Operators
    // can still flip it explicitly via LOG_LEVEL.
    disableRequestLogging: opts.config.NODE_ENV === 'test',
  });

  await app.register(sensible);
  // Cookie support — used by the auth slice to deliver the refresh token as
  // httpOnly+Secure+SameSite=Strict (SEC-001 / FE-02). Must be registered
  // before route plugins read or write cookies.
  await app.register(cookie);
  const allowedOrigins = parseAllowedOrigins(opts.config.ALLOWED_ORIGINS);
  await app.register(cors, {
    origin: allowedOrigins,
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

  // SEC-008: baseline Content-Security-Policy + companion hardening headers
  // on every API response. The API never serves HTML so a strict `default-src
  // 'self'` is correct; `frame-ancestors 'none'` is the modern equivalent of
  // X-Frame-Options and prevents API JSON from being framed. The web frontend
  // gets its own (more permissive) CSP via nginx/Traefik.
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('content-security-policy')) {
      reply.header(
        'content-security-policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    }
    if (!reply.hasHeader('x-content-type-options')) {
      reply.header('x-content-type-options', 'nosniff');
    }
    if (!reply.hasHeader('referrer-policy')) {
      reply.header('referrer-policy', 'no-referrer');
    }
    return payload;
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

  // SEC-011: pipe argon2 engine errors into the structured app logger.
  setPasswordLogger((msg) => app.log.warn(msg));

  // SEC-022: shout at startup if the operator left the LiveKit dev secret
  // in place. The placeholder string is the value shipped in .env.example.
  if (
    opts.config.NODE_ENV === 'production' &&
    opts.config.LIVEKIT_API_SECRET === 'devsecret-change-me'
  ) {
    app.log.error(
      'LIVEKIT_API_SECRET is still the .env.example placeholder. ' +
        'Rotate the LiveKit keys before exposing this instance.',
    );
  }

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
    await registerBanRoutes(app);
    await registerLocalFileRoutes(app, {
      storage,
      uploadMaxBytes: opts.config.UPLOAD_MAX_BYTES,
    });
    await registerAttachmentRoutes(app, storage);
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
      void initRedisBroker(opts.config.REDIS_URL, (msg) => app.log.warn(msg)).catch((err) => {
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

/**
 * Validate ALLOWED_ORIGINS at startup. Refuses any element that isn't a
 * scheme+host URL — guards against accidental wildcards or typos silently
 * loosening CORS with credentials enabled.
 */
function parseAllowedOrigins(raw: string): string[] {
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad: string[] = [];
  for (const origin of items) {
    if (origin === '*') {
      bad.push(`${origin} (wildcard is unsafe with credentials: true)`);
      continue;
    }
    try {
      const u = new URL(origin);
      if (!u.protocol || !u.host || u.protocol === 'file:') {
        bad.push(origin);
      }
    } catch {
      bad.push(origin);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `Invalid ALLOWED_ORIGINS entries: ${bad.join(', ')}. ` +
        `Each origin must be a full URL like https://tavern.example.com.`,
    );
  }
  return items;
}
