import { z } from 'zod';
import { loadDataKey } from './lib/data-key.js';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const envSchema = z.object({
  APP_NAME: z.string().default('Tavern'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3001'),

  /** The only required external service. */
  DATABASE_URL: z.string().min(1),

  /** Optional. When present, BullMQ + Redis pub/sub is used. */
  REDIS_URL: optionalString,

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  /**
   * Separate HMAC key for the short-lived staged-TOTP token issued between
   * password step and TOTP step of login. Domain-separated from the JWT
   * secret so a process that can mint access tokens cannot also forge a
   * staged token for an arbitrary userId (bypassing the password check).
   * When blank, falls back to JWT_ACCESS_SECRET prefixed with a domain
   * label — better than nothing but the operator should set this.
   */
  STAGED_TOTP_SECRET: optionalString,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 15),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  ALLOWED_ORIGINS: z.string().default('http://localhost:3030,http://localhost:3000'),

  // Wave 2 #4 — OpenGraph link previews. When false, the API never makes
  // outbound HTTP for unfurl — important for air-gapped self-hosters.
  OG_FETCH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ALLOW_PUBLIC_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * SEC-017: `trustProxy` must be enabled when the API runs behind a reverse
   * proxy (Traefik, nginx, an AWS ALB, etc.) so `req.ip` reflects the real
   * client and not the proxy. Enabling it when NOT behind a proxy lets any
   * client spoof `X-Forwarded-For` to evade rate limits. Default is true in
   * production (deployments use Traefik per docs/deployment.md) and false in
   * dev/test where the API is reached directly.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  // Trust & safety -----------------------------------------------------------
  TRUST_SAFETY_CORE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Optional — when blank, ClamAV scanning is skipped. */
  CLAMAV_HOST: optionalString,
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  /**
   * Default false: refuse uploads when no scanner is configured. Operators
   * who explicitly want unscanned uploads in dev/test environments must opt
   * in. The startup-time guard further refuses `true` in production when
   * CLAMAV_HOST is unset.
   */
  ALLOW_UNSCANNED_UPLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BLOCK_EXECUTABLE_UPLOADS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  BLOCK_ARCHIVE_UPLOADS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  STRIP_IMAGE_METADATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(4000),

  // Storage ------------------------------------------------------------------
  /**
   * "local" (default): files written to LOCAL_STORAGE_DIR, served by the API.
   * "s3":              files routed via the S3-compatible endpoint below.
   */
  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data/storage'),

  /** Used only when STORAGE_BACKEND=s3. */
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  S3_BUCKET: z.string().default('tavern-media'),
  S3_QUARANTINE_BUCKET: z.string().default('tavern-quarantine'),
  S3_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // LiveKit ------------------------------------------------------------------
  /** Optional. When blank, voice/video routes return 503. */
  LIVEKIT_URL: optionalString,
  LIVEKIT_API_KEY: optionalString,
  LIVEKIT_API_SECRET: optionalString,

  /** Pino log level. See SEC-013. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * S3 presigned-PUT URL expiry, in seconds. Default 600 (10 minutes). Lower
   * for stricter time-to-upload windows; higher for slow client connections.
   * STO-005.
   */
  S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(600),

  /**
   * Maximum upload payload size, in bytes (INF-017). Default 100 MiB.
   * Applied to:
   *  - the local-uploads route's per-request body limit
   *  - the validator's generic-file size cap (existing)
   * The nginx `client_max_body_size` (apps/web/nginx.conf) MUST be raised
   * in tandem; nginx doesn't read env vars at request time.
   */
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),

  // Mail / password-reset --------------------------------------------------
  /**
   * Public URL of the web frontend. Used to build links inside outbound
   * email (password-reset, future invites, etc.). Falls back to a sensible
   * dev default; production deployments must set it to the canonical
   * https origin so reset links resolve to a real, TLS-protected page.
   */
  WEB_BASE_URL: z.string().default('http://localhost:3030'),
  /**
   * Optional SMTP. When SMTP_HOST is blank, MailService logs the message
   * body to the structured logger instead of dispatching — useful in dev
   * and air-gapped self-hosts where the operator pipes mail through a
   * different channel.
   */
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  /**
   * From-address used on every outbound email. Defaults to
   * `no-reply@<PUBLIC_BASE_URL host>` if unset.
   */
  SMTP_FROM: optionalString,
  /** Lifetime of a password-reset token, in seconds. Default 1 hour. */
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),

  // WebAuthn / passkeys ----------------------------------------------------
  /**
   * Relying-Party identifier — must be the registrable domain (NOT the URL)
   * the user sees in the browser bar. Default `localhost` works for dev;
   * production deployments MUST set it to the canonical host (e.g.
   * `tavern.example.com`). WebAuthn refuses to register a credential when
   * RP ID and the page origin disagree, which is exactly how it defends
   * against phishing.
   */
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  /** Friendly relying-party name shown by the authenticator. */
  WEBAUTHN_RP_NAME: optionalString,
  /**
   * The full https origin the browser sees. Defaults to WEB_BASE_URL. Must
   * match exactly (scheme + host + port) — the authenticator binds the
   * credential to this origin.
   */
  WEBAUTHN_ORIGIN: optionalString,

  // AI / LLM ---------------------------------------------------------------
  /**
   * Wave 3 #48 — operator-configured OpenAI-compatible endpoint for AI
   * session recaps. Set to a Chat Completions URL (e.g.
   * `https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama,
   * `http://localhost:8080/v1` for llama.cpp's server). When blank,
   * `/api/campaigns/:id/recaps` returns 503 with a clear message and the UI
   * hides the "Generate recap" button.
   */
  LLM_ENDPOINT: optionalString,
  LLM_API_KEY: optionalString,
  /** Model identifier to send in the request body. Default suits OpenAI. */
  LLM_MODEL: z.string().default('gpt-4o-mini'),

  // OIDC / SSO -------------------------------------------------------------
  /**
   * Wave 3 #36 — OpenID Connect single sign-on. When `OIDC_ISSUER_URL` is
   * set, Tavern fetches `/.well-known/openid-configuration` from it on
   * boot, exposes a "Sign in with SSO" button on /login, and accepts
   * callbacks at `/api/auth/sso/callback`. Tested-against:
   * Keycloak, Authentik, Auth0, Microsoft Entra, Google. SAML deferred.
   */
  OIDC_ISSUER_URL: optionalString,
  OIDC_CLIENT_ID: optionalString,
  OIDC_CLIENT_SECRET: optionalString,
  /** Where the IdP redirects after auth. Defaults to `<PUBLIC_BASE_URL>/api/auth/sso/callback`. */
  OIDC_REDIRECT_URI: optionalString,
  /** Label shown on the login button. */
  OIDC_BUTTON_LABEL: z.string().default('Sign in with SSO'),
  /**
   * SEC: when `true` (default, for backwards-compat with single-IdP setups),
   * an SSO sign-in whose `(iss, sub)` doesn't match any local row falls back
   * to an `email_verified` lookup and AUTO-LINKS the matching local account.
   * For multi-IdP deployments this is account-takeover-shaped: a victim
   * with a known email can be silently linked by any new IdP the operator
   * configures. Set to `false` to disable the fallback — unmatched SSO users
   * then provision a NEW Tavern account (or, if the email collides, surface
   * an explicit-link prompt).
   */
  OIDC_AUTO_LINK_BY_EMAIL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Federation -------------------------------------------------------------
  /**
   * IR20 federation (phase 1: peering handshake only). When false, .well-known
   * returns 404, all /_federation and /api/admin/peers routes return 404, and
   * no signing key is generated. Safe to keep false on instances that don't
   * federate. See docs/federation.md.
   */
  FEDERATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * 32 raw bytes, base64-encoded. Encrypts the FederationKey.privateKey
   * column. Generate with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   * Required when FEDERATION_ENABLED=true in production.
   */
  TAVERN_DATA_KEY: optionalString,
  /**
   * Phase 5 — federated DMs (P5-11). When true (the default), the instance
   * advertises `'dms'` in its .well-known capability list, accepts inbound
   * `dm.*` envelopes, and fans out DM events to peers that also advertise
   * `dms`. When false:
   *   - `'dms'` is filtered out of the well-known capabilities array;
   *   - inbound `dm.*` handlers reject with 403 `dms_capability_missing`
   *     BEFORE checking the peer's stored capability set (defence-in-depth);
   *   - every outbound `fanOutDm*` call short-circuits at the route layer
   *     (no enqueue, no warning spam — DMs are opted out by THIS operator,
   *     not by an unreachable peer).
   * Requires FEDERATION_ENABLED=true to have any effect; with federation
   * fully off this flag is meaningless.
   */
  FEDERATION_DMS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Phase 6 — federated presence (P6-2). When true (the default), the instance
   * advertises `'presence'` in its .well-known capability list, accepts inbound
   * `presence.update` envelopes, and fans out presence transitions + custom
   * status changes to peers that also advertise `presence`. When false:
   *   - `'presence'` is filtered out of the well-known capabilities array;
   *   - inbound `presence.update` handlers reject with 403
   *     `presence_capability_missing` BEFORE checking the peer's stored
   *     capability set (defence-in-depth);
   *   - every outbound `fanOutPresenceUpdate` call short-circuits at the
   *     service layer (no enqueue, no warning spam — presence is opted out by
   *     THIS operator, not by an unreachable peer).
   * Requires FEDERATION_ENABLED=true to have any effect; with federation
   * fully off this flag is meaningless.
   */
  FEDERATION_PRESENCE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    const hint =
      `\n\nDid you copy .env.example to .env at the workspace root?` +
      `\n  cp .env.example .env` +
      `\n\nThen edit JWT_ACCESS_SECRET and JWT_REFRESH_SECRET — generate with:` +
      `\n  openssl rand -hex 48`;
    throw new Error(`Invalid environment configuration:\n${issues}${hint}`);
  }
  const cfg = parsed.data;

  // Cross-field validation: if STORAGE_BACKEND=s3, the S3 bits must be set.
  if (cfg.STORAGE_BACKEND === 's3') {
    const missing: string[] = [];
    if (!cfg.S3_ENDPOINT) missing.push('S3_ENDPOINT');
    if (!cfg.S3_ACCESS_KEY) missing.push('S3_ACCESS_KEY');
    if (!cfg.S3_SECRET_KEY) missing.push('S3_SECRET_KEY');
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_BACKEND=s3 but the following are missing: ${missing.join(', ')}.\n` +
          `Either set them, or switch to STORAGE_BACKEND=local.`,
      );
    }
  }
  // Federation: validate TAVERN_DATA_KEY when production federation is enabled.
  if (cfg.FEDERATION_ENABLED && cfg.NODE_ENV === 'production') {
    if (!cfg.TAVERN_DATA_KEY) {
      throw new Error(
        'FEDERATION_ENABLED=true requires TAVERN_DATA_KEY in production.\n' +
          'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
    // Run the same validator the API uses at bootstrap time — one canonical path.
    try {
      loadDataKey(cfg.TAVERN_DATA_KEY);
    } catch (e) {
      throw new Error(`TAVERN_DATA_KEY validation failed: ${(e as Error).message}`);
    }
  }

  // UPL-007: in production, refuse to launch with ALLOW_UNSCANNED_UPLOADS=true
  // *and* no scanner configured. Together that's "accept any binary the
  // client sends, unscanned" — fine for dev, dangerous on a public instance.
  if (cfg.NODE_ENV === 'production' && cfg.ALLOW_UNSCANNED_UPLOADS && !cfg.CLAMAV_HOST) {
    throw new Error(
      `NODE_ENV=production refuses ALLOW_UNSCANNED_UPLOADS=true without a CLAMAV_HOST.\n` +
        `Either set CLAMAV_HOST or set ALLOW_UNSCANNED_UPLOADS=false.`,
    );
  }
  return cfg;
}

export function describeConfig(cfg: Config): string {
  const storageDescr =
    cfg.STORAGE_BACKEND === 'local'
      ? `local (${cfg.LOCAL_STORAGE_DIR})`
      : `s3 (${cfg.S3_ENDPOINT})`;
  return [
    `  storage:  ${storageDescr}`,
    `  redis:    ${cfg.REDIS_URL ?? 'in-process (single-replica only)'}`,
    `  clamav:   ${
      cfg.CLAMAV_HOST
        ? `${cfg.CLAMAV_HOST}:${cfg.CLAMAV_PORT}`
        : `disabled (allowUnscanned=${cfg.ALLOW_UNSCANNED_UPLOADS})`
    }`,
    `  livekit:  ${cfg.LIVEKIT_URL ?? 'disabled (voice/video routes return 503)'}`,
    `  smtp:     ${
      cfg.SMTP_HOST
        ? `${cfg.SMTP_HOST}:${cfg.SMTP_PORT}${cfg.SMTP_SECURE ? ' (tls)' : ''}`
        : 'disabled (password-reset mails logged to console)'
    }`,
    `  federation: ${cfg.FEDERATION_ENABLED ? 'enabled' : 'disabled'}`,
  ].join('\n');
}
