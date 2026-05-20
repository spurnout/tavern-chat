import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
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
import { MailService } from './services/mail-service.js';
import { WebAuthnService } from './services/webauthn-service.js';
import { createStorage } from './services/storage.js';
import { createQueueClient, type FederationDispatcherSlot } from './services/queues.js';
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
import { registerSlashRoutes } from './routes/slash.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerPinRoutes } from './routes/pins.js';
import { registerSavedMessageRoutes } from './routes/saved.js';
import { registerThreadRoutes } from './routes/threads.js';
import { registerPollRoutes } from './routes/polls.js';
import { registerScheduledRoutes } from './routes/scheduled.js';
import { registerEncounterRoutes } from './routes/encounters.js';
import { registerLinkPreviewRoutes } from './routes/link-previews.js';
import { registerModerationActionRoutes } from './routes/moderation-actions.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerSoundboardRoutes } from './routes/soundboard.js';
import { registerRandomTableRoutes } from './routes/random-tables.js';
import { registerNpcRoutes } from './routes/npcs.js';
import { registerTotpRoutes } from './routes/totp.js';
import { registerWebauthnRoutes } from './routes/webauthn.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerTokenAndWebhookRoutes } from './routes/tokens-webhooks.js';
import { registerIcalRoutes } from './routes/ical.js';
import { registerStickerRoutes } from './routes/stickers.js';
import { registerBattleMapRoutes } from './routes/battle-maps.js';
import { registerCampaignCalendarRoutes } from './routes/campaign-calendar.js';
import { registerCampaignSafetyRoutes } from './routes/campaign-safety.js';
import { registerDeckRoutes } from './routes/decks.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerWatchPartyRoutes } from './routes/watch-party.js';
import { registerCaptionRoutes } from './routes/captions.js';
import { registerRecapRoutes } from './routes/recaps.js';
import { RecapService } from './services/recap-service.js';
import { registerBreakoutRoutes } from './routes/breakouts.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerSsoRoutes } from './routes/sso.js';
import { OidcService } from './services/oidc-service.js';
import { registerWhiteboardRoutes } from './routes/whiteboard.js';
import { registerEncounterTemplateRoutes } from './routes/encounter-templates.js';
import { registerAutomodRoutes } from './routes/automod.js';
import { registerWarningRoutes } from './routes/warnings.js';
import { registerJoinGateRoutes } from './routes/join-gates.js';
import { registerServerTemplateRoutes } from './routes/server-templates.js';
import { registerServerBackupRoutes } from './routes/server-backup.js';
import { registerPushRoutes } from './routes/push.js';
import { registerRssRoutes } from './routes/rss.js';
import { registerAdminStorageRoutes } from './routes/admin-storage.js';
import { registerMemberDirectoryRoutes } from './routes/member-directory.js';
import { registerMemberStatusRoutes } from './routes/member-status.js';
import { registerCompendiumRoutes } from './routes/compendium.js';
import { registerMetricsPlugin } from './plugins/metrics.js';
import { loadPluginsFrom } from './services/plugin-loader.js';
import { recoverScheduledDispatches } from './services/scheduler.js';
import { registerBoardGameRoutes } from './routes/board-games.js';
import { registerGameNightRoutes } from './routes/game-nights.js';
import { registerModerationRoutes } from './routes/moderation.js';
import { registerTypingRoutes } from './routes/typing.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerPresenceRoutes } from './routes/presence.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerDmRoutes } from './routes/dms.js';
import { registerUserRoutes } from './routes/users.js';
import { registerGateway } from './gateway/index.js';
import { initRedisBroker, setBrokerLogger } from './services/gateway-broker.js';
import { ok } from './lib/responses.js';
import { registerWellKnownRoutes } from './routes/well-known.js';
import { registerFederationPeeringRoutes } from './routes/federation-peering.js';
import { registerAdminFederationRoutes } from './routes/admin-federation.js';
import { registerFederationProfileRoutes } from './routes/federation-profile.js';
import { registerFederationEventsRoutes } from './routes/federation-events.js';
import { registerUsersFederatedRoutes } from './routes/users-federated.js';
import { FederationKeyStore } from './services/federation-keys.js';
import { FederationPeeringService } from './services/federation-peering.js';
import { FederationProfileService } from './services/federation-profile.js';
import { FederationInboundService } from './services/federation-inbound.js';
import { UserKeyStore } from './services/user-keys.js';
import { loadDataKey } from './lib/data-key.js';

export interface BuildAppOptions {
  config: Config;
  /** When true, skip route modules that need infra services (used by auth tests). */
  authOnly?: boolean;
  /**
   * Test-only override for the queue client. When set, replaces the queue
   * factory's output so tests can drop a vi.fn() in for `enqueueFederationOutbox`
   * without standing up Redis or wiring the in-memory dispatcher. Has no
   * effect on the storage / scan path beyond what the override implements.
   */
  queuesOverride?: import('./services/queues.js').QueueClient;
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
    loggerInstance: createLogger(opts.config.NODE_ENV),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy,
    // SEC-013: request logging is on in production by default and suppressed
    // in the test runner where it would drown the assertion output. Operators
    // can still flip it explicitly via LOG_LEVEL.
    disableRequestLogging: opts.config.NODE_ENV === 'test',
  });
  // Plumb app.log into the gateway broker so its in-process publish failures
  // surface via structured logging instead of console.warn.
  setBrokerLogger((msg) => app.log.warn(msg));

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

  // SEC-022: shout at startup if the operator left the LiveKit dev keys in
  // place — both `devkey` and `devsecret-change-me` are public in the repo,
  // so anyone could self-sign LiveKit JWTs against the deployment.
  //
  // We warn loudly rather than crash. The docker-compose stack ships with
  // NODE_ENV=production for the api container even when used locally, and
  // the dev keys are the *intended* values in that scenario; crashing
  // would break the out-of-the-box `pnpm docker:up:full` workflow.
  // Operators exposing this to the public internet must rotate — the
  // warning in the logs is the signal.
  if (opts.config.NODE_ENV === 'production') {
    if (opts.config.LIVEKIT_API_SECRET === 'devsecret-change-me') {
      app.log.error(
        'LIVEKIT_API_SECRET is still the .env.example placeholder. ' +
          'Rotate it before exposing this instance to the public internet.',
      );
    }
    if (opts.config.LIVEKIT_API_KEY === 'devkey') {
      app.log.error(
        'LIVEKIT_API_KEY is still the .env.example placeholder. ' +
          'Rotate it (with the matching secret) before exposing this instance to the public internet.',
      );
    }
    // SEC-023: warn if voice signaling is unencrypted. The LiveKit token
    // grants `canPublishSources` for the session; a passive listener on a
    // `ws://` connection has a replayable credential.
    if (opts.config.LIVEKIT_URL && opts.config.LIVEKIT_URL.startsWith('ws://')) {
      app.log.error(
        `LIVEKIT_URL is ${opts.config.LIVEKIT_URL} — use wss:// in production ` +
          'so signaling and the JWT delivery channel are TLS-encrypted.',
      );
    }
  }

  const mailService = new MailService(opts.config, app.log);

  // Hoisted so AuthService (constructed below) can receive it even though
  // the federation block that populates it lives inside the !authOnly guard.
  // Non-federation or authOnly builds leave it null → AuthService skips keypair
  // provisioning (safe — the field is optional).
  let userKeys: UserKeyStore | null = null;

  const authService = new AuthService({
    jwt,
    config: opts.config,
    mail: mailService,
    get userKeyStore() { return userKeys ?? undefined; },
    logger: app.log,
  });
  const webauthnService = new WebAuthnService(opts.config);

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
        ssoEnabled: Boolean(
          opts.config.OIDC_ISSUER_URL &&
            opts.config.OIDC_CLIENT_ID &&
            opts.config.OIDC_CLIENT_SECRET,
        ),
        ssoButtonLabel: opts.config.OIDC_BUTTON_LABEL,
        aiRecapEnabled: Boolean(opts.config.LLM_ENDPOINT),
        federationEnabled: opts.config.FEDERATION_ENABLED,
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
    // P3-5: the queue client needs the federation key + user-key stores to
    // sign outbound envelopes, but those are constructed inside the
    // FEDERATION_ENABLED block below. Wire them through a getter so the
    // queue client picks them up lazily after federation bootstrap.
    let federationDispatcherSlot: FederationDispatcherSlot | null = null;
    const queues =
      opts.queuesOverride ??
      createQueueClient(opts.config, {
        storage,
        scanner,
        logger: app.log,
        getFederationDispatcher: () => federationDispatcherSlot,
      });

    let federationKeys: FederationKeyStore | null = null;
    let federationProfile: FederationProfileService | null = null;
    // P3-6: `selfHost` is hoisted out of the FEDERATION_ENABLED block so
    // registerMessageRoutes can be passed it as a dep — the outbound fan-out
    // helper needs `<localpart>@<selfHost>` to build remote-user identifiers.
    // It stays null when federation is off, which gates the fan-out path
    // inside the route handler.
    let selfHost: string | null = null;
    if (opts.config.FEDERATION_ENABLED) {
      const dataKey = loadDataKey(opts.config.TAVERN_DATA_KEY);
      federationKeys = new FederationKeyStore({ dataKey });
      await federationKeys.bootstrap();
      registerWellKnownRoutes(app, {
        keys: federationKeys,
        config: opts.config,
        softwareVersion: 'tavern/0.0.0',
      });
      const peering = new FederationPeeringService();
      registerFederationPeeringRoutes(app, { service: peering });
      registerAdminFederationRoutes(app, {
        service: peering,
        keys: federationKeys!,
        config: opts.config,
      });
      // Provision the per-user key store so new users get a signing keypair
      // at registration (Phase 2 task 4). Uses the same dataKey already in scope.
      userKeys = new UserKeyStore({ dataKey });
      selfHost = new URL(opts.config.PUBLIC_BASE_URL).host;
      federationProfile = new FederationProfileService({
        keys: federationKeys!,
        userKeys: userKeys!,
        selfHost,
      });
      registerFederationProfileRoutes(app, { service: federationProfile });
      // P3-7 — inbound message-event endpoint. Re-uses the same profile
      // service for the on-cache-miss `fetchRemoteProfile` lookup that
      // resolves an unknown author's public key.
      const federationInbound = new FederationInboundService({
        profile: federationProfile,
      });
      registerFederationEventsRoutes(app, { service: federationInbound });
      registerUsersFederatedRoutes(app, { service: federationProfile });
      // P3-5: now that all three pieces exist, populate the slot the queue
      // client closure reads on every outbox enqueue.
      federationDispatcherSlot = {
        keys: federationKeys!,
        userKeys: userKeys!,
        selfHost,
      };
    }

    await registerServerRoutes(app);
    await registerChannelRoutes(app);
    await registerMessageRoutes(app, { federationProfile, queues, selfHost });
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
    await registerReactionRoutes(app, { queues, selfHost });
    await registerEmojiRoutes(app);
    await registerVoiceRoutes(app, opts.config);
    await registerCampaignRoutes(app);
    await registerSessionRoutes(app);
    await registerNoteRoutes(app);
    await registerHandoutRoutes(app);
    await registerDiceRoutes(app);
    await registerSlashRoutes(app);
    await registerInboxRoutes(app);
    await registerPinRoutes(app);
    await registerSavedMessageRoutes(app);
    await registerThreadRoutes(app);
    await registerPollRoutes(app);
    await registerScheduledRoutes(app);
    await registerEncounterRoutes(app);
    await registerLinkPreviewRoutes(app);
    await registerModerationActionRoutes(app);
    await registerCharacterRoutes(app);
    await registerSoundboardRoutes(app);
    await registerRandomTableRoutes(app);
    await registerNpcRoutes(app);
    await registerTotpRoutes(app);
    await registerWebauthnRoutes(app, {
      webauthn: webauthnService,
      auth: authService,
      config: opts.config,
    });
    await registerAccountRoutes(app, { storage });
    await registerDraftRoutes(app);
    await registerTokenAndWebhookRoutes(app);
    await registerIcalRoutes(app);
    // Wave 3 routes.
    await registerStickerRoutes(app);
    await registerBattleMapRoutes(app);
    await registerCampaignCalendarRoutes(app);
    await registerCampaignSafetyRoutes(app);
    await registerDeckRoutes(app);
    await registerImportRoutes(app);
    await registerWatchPartyRoutes(app);
    await registerCaptionRoutes(app);
    const recapService = new RecapService(opts.config);
    await registerRecapRoutes(app, { recap: recapService });
    await registerBreakoutRoutes(app, opts.config);
    await registerRecordingRoutes(app);
    await registerPluginRoutes(app);
    const oidcService = new OidcService(opts.config);
    await registerSsoRoutes(app, { oidc: oidcService, auth: authService, config: opts.config });
    await registerWhiteboardRoutes(app);
    await registerEncounterTemplateRoutes(app);
    await registerAutomodRoutes(app);
    await registerWarningRoutes(app);
    await registerJoinGateRoutes(app);
    await registerServerTemplateRoutes(app);
    await registerServerBackupRoutes(app, { storage });
    await registerPushRoutes(app);
    await registerRssRoutes(app);
    await registerAdminStorageRoutes(app);
    await registerMemberDirectoryRoutes(app);
    await registerMemberStatusRoutes(app);
    await registerCompendiumRoutes(app);
    registerMetricsPlugin(app);
    void loadPluginsFrom(
      // PLUGINS_DIR overrides the default; otherwise look next to the api
      // package root so a self-host can drop files alongside the source.
      process.env['PLUGINS_DIR'] ?? path.resolve(process.cwd(), 'plugins'),
      app.log,
    ).catch((err) => app.log.warn({ err }, 'plugin loader bootstrap failed'));
    await registerBoardGameRoutes(app);
    await registerGameNightRoutes(app);
    await registerModerationRoutes(app);
    await registerTypingRoutes(app);
    await registerSearchRoutes(app);
    await registerPresenceRoutes(app);
    await registerNotificationRoutes(app);
    await registerDmRoutes(app);
    await registerUserRoutes(app);
    registerGateway(app, jwt);

    if (opts.config.NODE_ENV !== 'test' && opts.config.REDIS_URL) {
      void initRedisBroker(opts.config.REDIS_URL, (msg) => app.log.warn(msg)).catch((err) => {
        app.log.warn({ err }, 'redis broker init failed; staying in-process');
      });
    }

    // Phase 3.3 — rearm any pending scheduled dispatches whose time is in
    // the next 24h. Anything further out is picked up at the next restart.
    if (opts.config.NODE_ENV !== 'test') {
      void recoverScheduledDispatches().catch((err) =>
        app.log.warn({ err }, 'scheduled-dispatch recovery failed'),
      );
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
