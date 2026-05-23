import crypto from 'node:crypto';
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from 'jose';
import { prisma } from '@tavern/db';
import type { Config } from '../config.js';
import { TavernError, ulid } from '@tavern/shared';
import { InMemoryEphemeralStore, type EphemeralStore } from '../lib/ephemeral-store.js';
import { pinnedFetch } from '../lib/pinned-fetch.js';

const OIDC_FETCH_TIMEOUT_MS = 8_000;
/**
 * Maximum number of pending SSO `state` entries the in-memory backend will
 * hold. Has no effect on the Redis-backed backend (key TTLs handle eviction
 * there). A login dance is a few seconds long, so even on a busy instance
 * this is huge headroom. Bound matters because /api/auth/sso/start is
 * unauthenticated.
 */
const MAX_PENDING_STATES = 1_024;

/**
 * Wrapper around `pinnedFetch` that converts its failure modes into typed
 * `TavernError`s so the callback path returns a 502 with a useful message
 * instead of a generic 500. The pinned-fetch helper handles the SSRF +
 * DNS-rebinding mitigation and per-request timeout for us; we just need to
 * shape the error.
 */
type PinnedFetchInit = NonNullable<Parameters<typeof pinnedFetch>[1]>['init'];

async function fetchOidc(url: string, init?: PinnedFetchInit): Promise<Response> {
  try {
    return await pinnedFetch(url, {
      timeoutMs: OIDC_FETCH_TIMEOUT_MS,
      init,
    });
  } catch (err) {
    throw new TavernError(
      'INTERNAL_ERROR',
      `OIDC fetch failed for ${url}: ${err instanceof Error ? err.message : 'unknown'}`,
      502,
    );
  }
}

/**
 * Wave 3 #36 — Minimal OIDC client.
 *
 * Implemented against the OIDC Authorization Code flow without PKCE (V1
 * supports server-side confidential clients). Public clients with PKCE is
 * a documented follow-up. The discovery + JWKS roundtrip is cached after
 * the first hit so per-request cost stays at one HTTP call (the token
 * exchange) plus signature verification.
 */

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingState {
  state: string;
  /** ULID of the optional Tavern user the state is bound to (account-linking). */
  linkingUserId?: string;
}

/** Re-fetch the JWKS at most this often even when we already have a copy. */
const JWKS_MAX_AGE_MS = 30 * 60 * 1000;
/**
 * After a verify miss we wait at least this long before re-fetching, so a
 * spike of stale-key requests can't turn into a fetch storm against the
 * IdP. Mirrors the cool-down `createRemoteJWKSet` uses internally.
 */
const JWKS_MIN_REFETCH_MS = 30 * 1000;

interface CachedJwks {
  verifier: ReturnType<typeof createLocalJWKSet>;
  fetchedAt: number;
}

export class OidcService {
  private discoveryPromise: Promise<OidcDiscovery> | null = null;
  private jwksCache: CachedJwks | null = null;
  private jwksLastFetchAttempt = 0;
  private readonly states: EphemeralStore;

  constructor(
    private readonly config: Config,
    states?: EphemeralStore,
  ) {
    this.states = states ?? new InMemoryEphemeralStore({ cap: MAX_PENDING_STATES });
  }

  isEnabled(): boolean {
    return Boolean(
      this.config.OIDC_ISSUER_URL &&
        this.config.OIDC_CLIENT_ID &&
        this.config.OIDC_CLIENT_SECRET,
    );
  }

  buttonLabel(): string {
    return this.config.OIDC_BUTTON_LABEL;
  }

  redirectUri(): string {
    return (
      this.config.OIDC_REDIRECT_URI ??
      `${this.config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/auth/sso/callback`
    );
  }

  /**
   * Build the URL the user is sent to in order to start the SSO dance.
   * `linkingUserId` is set when an already-authenticated user is linking
   * an OIDC identity to their existing account.
   */
  async buildAuthorizeUrl(opts?: { linkingUserId?: string }): Promise<string> {
    const disc = await this.discover();
    const state = crypto.randomBytes(24).toString('base64url');
    const pending: PendingState = { state };
    if (opts?.linkingUserId) pending.linkingUserId = opts.linkingUserId;
    // TTL + cap (for the in-memory backend) are handled inside the store.
    await this.states.set(state, pending, STATE_TTL_MS);
    const url = new URL(disc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.OIDC_CLIENT_ID as string);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * Handle the callback: exchange the code for an id_token, verify it,
   * resolve to a Tavern user (link or create as appropriate). Returns the
   * userId so the caller can issue a session, plus optional context about
   * an account-linking flow.
   */
  async handleCallback(code: string, state: string): Promise<{
    userId: string;
    linked: boolean;
    issuerLinkingMismatch?: boolean;
  }> {
    const pending = await this.states.get<PendingState>(state);
    if (!pending) {
      throw TavernError.unauthorized('SSO state invalid or expired');
    }
    await this.states.delete(state);
    const disc = await this.discover();
    // SSRF + DNS-rebinding-safe POST to the IdP-advertised token endpoint:
    // a malicious discovery doc could otherwise point us at an internal
    // service or use TOCTOU DNS to slip past the host check.
    const tokenResp = await fetchOidc(disc.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
        client_id: this.config.OIDC_CLIENT_ID as string,
        client_secret: this.config.OIDC_CLIENT_SECRET as string,
      }).toString(),
    });
    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => '');
      throw new TavernError(
        'INTERNAL_ERROR',
        `SSO token exchange failed: ${tokenResp.status} ${text.slice(0, 200)}`,
        502,
      );
    }
    const tokens = (await tokenResp.json()) as { id_token?: string };
    if (!tokens.id_token) {
      throw new TavernError('INVALID_TOKEN', 'No id_token in OIDC response', 502);
    }
    const claims = await this.verifyIdToken(tokens.id_token, disc);
    return this.resolveUser(claims, pending.linkingUserId);
  }

  async unlink(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { oidcIssuer: null, oidcSubject: null },
    });
  }

  private async discover(): Promise<OidcDiscovery> {
    if (!this.config.OIDC_ISSUER_URL) {
      throw new TavernError('INTERNAL_ERROR', 'SSO not configured', 503);
    }
    if (!this.discoveryPromise) {
      const url = `${this.config.OIDC_ISSUER_URL.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      this.discoveryPromise = (async () => {
        // SSRF + DNS-rebinding guard on the operator-configured issuer URL.
        // The issuer is a config value so the immediate threat surface is
        // low, but defence in depth: if it ever resolves to a private IP
        // we refuse to fetch.
        const r = await fetchOidc(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        if (!r.ok) {
          throw new Error(`discovery failed: ${r.status}`);
        }
        return (await r.json()) as OidcDiscovery;
      })().catch((err) => {
        // Drop the cached promise on failure so a transient hiccup at
        // boot doesn't poison the service for the process lifetime.
        this.discoveryPromise = null;
        throw err;
      });
    }
    return this.discoveryPromise;
  }

  /**
   * Fetch the JWKS document at `jwks_uri` through `pinnedFetch` and build a
   * local verifier. Cached on the instance with a max age and a min refetch
   * cool-down — mirrors what `createRemoteJWKSet` does internally, except
   * the network call now goes through our SSRF / DNS-pinning helper instead
   * of jose's native fetch (which would otherwise resolve `jwks_uri`'s
   * hostname fresh on every miss, defeating the discovery-time pin).
   *
   * `force` skips the cache and triggers a refetch — used on signature
   * miss to pull in newly-rotated keys.
   */
  private async loadJwks(disc: OidcDiscovery, force = false): Promise<CachedJwks> {
    const now = Date.now();
    if (
      !force &&
      this.jwksCache &&
      now - this.jwksCache.fetchedAt < JWKS_MAX_AGE_MS
    ) {
      return this.jwksCache;
    }
    // Cool-down so a flood of failing verifications can't turn into a fetch
    // storm against the IdP. The previous successful cache is reused
    // whenever the cool-down hasn't elapsed.
    if (force && this.jwksCache && now - this.jwksLastFetchAttempt < JWKS_MIN_REFETCH_MS) {
      return this.jwksCache;
    }
    this.jwksLastFetchAttempt = now;
    const r = await fetchOidc(disc.jwks_uri, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!r.ok) {
      throw new TavernError('INTERNAL_ERROR', `JWKS fetch failed: ${r.status}`, 502);
    }
    const body = (await r.json()) as JSONWebKeySet;
    const verifier = createLocalJWKSet(body);
    this.jwksCache = { verifier, fetchedAt: now };
    return this.jwksCache;
  }

  private async verifyIdToken(
    idToken: string,
    disc: OidcDiscovery,
  ): Promise<OidcIdTokenClaims> {
    let cached = await this.loadJwks(disc);
    let payload;
    try {
      const result = await jwtVerify(idToken, cached.verifier, {
        issuer: disc.issuer,
        audience: this.config.OIDC_CLIENT_ID,
      });
      payload = result.payload as unknown as OidcIdTokenClaims;
    } catch (err) {
      // Key rotation: if the verifier didn't recognise the kid, the IdP may
      // have rotated keys since our last fetch. Refresh once and retry —
      // any other failure (signature mismatch, expiry, audience drift, etc.)
      // bubbles straight up.
      if (err instanceof joseErrors.JWKSNoMatchingKey) {
        try {
          cached = await this.loadJwks(disc, true);
          const result = await jwtVerify(idToken, cached.verifier, {
            issuer: disc.issuer,
            audience: this.config.OIDC_CLIENT_ID,
          });
          payload = result.payload as unknown as OidcIdTokenClaims;
        } catch (retryErr) {
          throw new TavernError(
            'INVALID_TOKEN',
            `SSO id_token verification failed: ${retryErr instanceof Error ? retryErr.message : 'unknown'}`,
            401,
          );
        }
      } else {
        throw new TavernError(
          'INVALID_TOKEN',
          `SSO id_token verification failed: ${err instanceof Error ? err.message : 'unknown'}`,
          401,
        );
      }
    }
    if (!payload.sub || !payload.iss) {
      throw new TavernError('INVALID_TOKEN', 'SSO id_token missing iss/sub', 401);
    }
    return payload;
  }

  private async resolveUser(
    claims: OidcIdTokenClaims,
    linkingUserId?: string,
  ): Promise<{ userId: string; linked: boolean; issuerLinkingMismatch?: boolean }> {
    // 1. If we're linking, attach to the explicit Tavern user.
    if (linkingUserId) {
      const existing = await prisma.user.findUnique({
        where: { id: linkingUserId },
        select: { id: true, oidcIssuer: true, oidcSubject: true },
      });
      if (!existing) throw TavernError.notFound('Tavern user not found');
      if (existing.oidcIssuer && existing.oidcSubject) {
        // Already linked to something — refuse silent overwrite.
        if (existing.oidcIssuer !== claims.iss || existing.oidcSubject !== claims.sub) {
          return { userId: existing.id, linked: false, issuerLinkingMismatch: true };
        }
        return { userId: existing.id, linked: true };
      }
      await prisma.user.update({
        where: { id: existing.id },
        data: { oidcIssuer: claims.iss, oidcSubject: claims.sub },
      });
      return { userId: existing.id, linked: true };
    }

    // 2. Look up by (issuer, subject).
    const bySso = await prisma.user.findFirst({
      where: { oidcIssuer: claims.iss, oidcSubject: claims.sub },
      select: { id: true },
    });
    if (bySso) return { userId: bySso.id, linked: false };

    // 3. Try email-match if the IdP says the email is verified AND the
    //    operator has opted into the auto-link fallback (OIDC_AUTO_LINK_BY_EMAIL).
    //    Skipping this branch means an unmatched SSO sign-in falls through to
    //    new-account provisioning even when the email collides — the unique
    //    constraint on User.emailLower then forces an explicit-link UX (or,
    //    for a single-IdP setup, the operator can keep the default and the
    //    fallback behaves as before).
    if (
      this.config.OIDC_AUTO_LINK_BY_EMAIL &&
      claims.email &&
      claims.email_verified !== false
    ) {
      const byEmail = await prisma.user.findUnique({
        where: { emailLower: claims.email.toLowerCase() },
        select: { id: true, oidcIssuer: true },
      });
      if (byEmail && !byEmail.oidcIssuer) {
        await prisma.user.update({
          where: { id: byEmail.id },
          data: { oidcIssuer: claims.iss, oidcSubject: claims.sub },
        });
        return { userId: byEmail.id, linked: true };
      }
    }

    // 4. Create a new account. Username collisions get a numeric suffix.
    const base = (claims.preferred_username || claims.email?.split('@')[0] || `user-${claims.sub.slice(0, 8)}`)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '-')
      .slice(0, 40);
    const username = await uniqueUsername(base);
    const displayName = claims.name || claims.preferred_username || username;
    // When the IdP omits an email we synthesise `<sub>@<iss-host>`. The pair
    // `(iss, sub)` is unique-per-user so this synthetic value is also unique,
    // but two providers that both omit emails for users with the same sub
    // would collide. Run it through `uniqueEmail` to absorb that case
    // (it appends `+N` before the `@`). Defer the `new URL(claims.iss)`
    // parse so a malformed issuer string never throws on the common path
    // where the IdP DID return an email.
    const email = claims.email
      ? claims.email
      : await uniqueEmail(`${claims.sub}@${safeIssuerHost(claims.iss)}`);
    const created = await prisma.user.create({
      data: {
        id: ulid(),
        username,
        usernameLower: username.toLowerCase(),
        displayName,
        email,
        emailLower: email.toLowerCase(),
        // Empty password hash — the user can't log in via password until
        // they set one via the password-reset flow. SSO-only is fine.
        passwordHash: '',
        oidcIssuer: claims.iss,
        oidcSubject: claims.sub,
      },
    });
    return { userId: created.id, linked: false };
  }
}

/**
 * Best-effort `new URL(iss).host` that returns a safe placeholder if the
 * issuer claim isn't a URL. `iss` has already been compared against the
 * discovery doc's issuer (which IS a URL the operator configured), so the
 * fallback path should be unreachable in practice — this guards against a
 * future schema change rather than producing a generic 500.
 */
function safeIssuerHost(iss: string): string {
  try {
    return new URL(iss).host || 'idp.invalid';
  } catch {
    return 'idp.invalid';
  }
}

async function uniqueUsername(base: string): Promise<string> {
  let candidate = base || 'user';
  for (let i = 0; i < 50; i += 1) {
    const exists = await prisma.user.findUnique({
      where: { usernameLower: candidate.toLowerCase() },
      select: { id: true },
    });
    if (!exists) return candidate;
    candidate = `${base}-${i + 1}`;
  }
  // Fall back to a random suffix.
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Synthetic-email uniqueness for OIDC accounts whose IdP didn't return an
 * `email` claim. Reuses the `localpart+N@host` shape so the value stays a
 * RFC 5321-shaped string. Falls back to a random local suffix after 50
 * attempts so a pathologically misconfigured IdP can't brick registration.
 */
async function uniqueEmail(base: string): Promise<string> {
  const atIdx = base.indexOf('@');
  const localpart = atIdx >= 0 ? base.slice(0, atIdx) : base;
  const domain = atIdx >= 0 ? base.slice(atIdx + 1) : 'invalid.local';
  let candidate = base;
  for (let i = 0; i < 50; i += 1) {
    const exists = await prisma.user.findUnique({
      where: { emailLower: candidate.toLowerCase() },
      select: { id: true },
    });
    if (!exists) return candidate;
    candidate = `${localpart}+${i + 1}@${domain}`;
  }
  return `${localpart}+${crypto.randomBytes(3).toString('hex')}@${domain}`;
}
