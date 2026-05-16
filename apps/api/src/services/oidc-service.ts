import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '@tavern/db';
import type { Config } from '../config.js';
import { TavernError, ulid } from '@tavern/shared';

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
  expiresAt: number;
  /** ULID of the optional Tavern user the state is bound to (account-linking). */
  linkingUserId?: string;
}

export class OidcService {
  private discoveryPromise: Promise<OidcDiscovery> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private readonly states: Map<string, PendingState> = new Map();

  constructor(private readonly config: Config) {}

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
    const pending: PendingState = { state, expiresAt: Date.now() + STATE_TTL_MS };
    if (opts?.linkingUserId) pending.linkingUserId = opts.linkingUserId;
    this.states.set(state, pending);
    this.gcStates();
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
    const pending = this.states.get(state);
    if (!pending || pending.expiresAt < Date.now()) {
      throw TavernError.unauthorized('SSO state invalid or expired');
    }
    this.states.delete(state);
    const disc = await this.discover();
    const tokenResp = await fetch(disc.token_endpoint, {
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
      this.discoveryPromise = fetch(url)
        .then(async (r) => {
          if (!r.ok) {
            throw new Error(`discovery failed: ${r.status}`);
          }
          return (await r.json()) as OidcDiscovery;
        })
        .catch((err) => {
          // Drop the cached promise on failure so a transient hiccup at
          // boot doesn't poison the service for the process lifetime.
          this.discoveryPromise = null;
          throw err;
        });
    }
    return this.discoveryPromise;
  }

  private async verifyIdToken(
    idToken: string,
    disc: OidcDiscovery,
  ): Promise<OidcIdTokenClaims> {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(disc.jwks_uri));
    }
    let payload;
    try {
      const result = await jwtVerify(idToken, this.jwks, {
        issuer: disc.issuer,
        audience: this.config.OIDC_CLIENT_ID,
      });
      payload = result.payload as unknown as OidcIdTokenClaims;
    } catch (err) {
      throw new TavernError(
        'INVALID_TOKEN',
        `SSO id_token verification failed: ${err instanceof Error ? err.message : 'unknown'}`,
        401,
      );
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

    // 3. Try email-match if the IdP says the email is verified.
    if (claims.email && claims.email_verified !== false) {
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
    const email = claims.email ?? `${claims.sub}@${new URL(claims.iss).host}`;
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

  private gcStates(): void {
    const now = Date.now();
    for (const [k, v] of this.states) {
      if (v.expiresAt < now) this.states.delete(k);
    }
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
