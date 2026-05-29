import { Prisma, prisma } from '@tavern/db';
import {
  ErrorCodes,
  NAME_LIMITS,
  PERMISSION_DEFAULT_EVERYONE,
  TavernError,
  TOKEN_TTL,
  serializePermissions,
  ulid,
  type BootstrapRequest,
  type LoginRequest,
  type RegisterRequest,
  type TokenPair,
} from '@tavern/shared';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { sha256, randomTokenHex } from '../lib/hash.js';
import { generateInviteCode } from '../lib/invite-codes.js';
import { hashBackupCode, verifyTotpWithCounter } from '../lib/totp.js';
import type { JwtService } from '../lib/jwt.js';
import type { Config } from '../config.js';
import type { MailService } from './mail-service.js';
import type { UserKeyStore } from './user-keys.js';

/**
 * Error thrown by `login()` when the user has TOTP enabled. The route
 * handler catches this specifically and returns `{ totpRequired, stagedToken }`
 * to the client. Modeled as an exception (rather than a discriminated return)
 * so the existing login signature on the wire stays clean for the common case.
 */
export class TotpRequiredError extends Error {
  constructor(public readonly stagedToken: string) {
    super('TOTP_REQUIRED');
    this.name = 'TotpRequiredError';
  }
}

const STAGED_TOTP_TTL_MS = 5 * 60 * 1000;
const STAGED_TOTP_VERSION = 1;

/**
 * Resolve the HMAC key for staged-TOTP tokens. Prefers a dedicated config
 * value so it's domain-separated from JWT_ACCESS_SECRET — without that
 * separation, any process holding the JWT signing key could forge a staged
 * token for any userId and skip the password step. When unset, falls back
 * to a labelled derivation so existing deployments keep working; operators
 * SHOULD set STAGED_TOTP_SECRET explicitly in production.
 */
export function getStagedTotpKey(config: Config): string {
  if (config.STAGED_TOTP_SECRET && config.STAGED_TOTP_SECRET.length >= 32) {
    return config.STAGED_TOTP_SECRET;
  }
  return `tvn-totp-stage-fallback:${config.JWT_ACCESS_SECRET}`;
}

export function signStagedTotpToken(userId: string, key: string): string {
  const expires = Date.now() + STAGED_TOTP_TTL_MS;
  const payload = `${STAGED_TOTP_VERSION}.${userId}.${expires}`;
  const sig = crypto
    .createHmac('sha256', `tvn-totp-stage:${key}`)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyStagedTotpToken(token: string, key: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, userId, expiresStr, sig] = parts;
  if (version !== String(STAGED_TOTP_VERSION) || !userId || !expiresStr || !sig) return null;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  const expected = crypto
    .createHmac('sha256', `tvn-totp-stage:${key}`)
    .update(`${version}.${userId}.${expiresStr}`)
    .digest('base64url');
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  return userId;
}

export interface AuthServiceDeps {
  jwt: JwtService;
  config: Config;
  mail: MailService;
  /** Optional: when FEDERATION_ENABLED, provision a signing keypair for new users. */
  userKeyStore?: UserKeyStore;
  /** Optional structured logger (pino-compatible). Falls back to console.warn when absent. */
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface SessionContext {
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
  deviceName?: string | null | undefined;
}

/** Number of consecutive failed logins before the account is temporarily locked. */
const FAILED_LOGIN_LOCKOUT_THRESHOLD = 10;
/** How long a locked account stays locked after the threshold is hit. */
const FAILED_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Mirror of FAILED_LOGIN_LOCKOUT_THRESHOLD for the TOTP step. Without this,
 * an attacker with a valid password but no TOTP code can grind the 6-digit
 * code from a staged token (5-minute TTL) without ever hitting a counter.
 */
const FAILED_TOTP_LOCKOUT_THRESHOLD = 8;
const FAILED_TOTP_LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Per-user active session cap (SEC-009). When a new session is issued and the
 * user already has more than this many active sessions, the oldest are
 * revoked. Catches both runaway test suites and credential-stuffing attacks
 * that survive lockout by rotating IPs.
 */
const MAX_ACTIVE_SESSIONS_PER_USER = 20;

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async register(req: RegisterRequest, ctx: SessionContext): Promise<TokenPair> {
    const usernameLower = req.username.toLowerCase();
    const emailLower = req.email.toLowerCase();
    const inviteCode = req.inviteCode.trim().toUpperCase();

    if (usernameLower.length < NAME_LIMITS.MIN_USERNAME) {
      throw TavernError.validation('Username too short');
    }

    // Pre-flight invite check — surfaces "invite is invalid" before we spend
    // CPU on the Argon2 hash. The authoritative check is the atomic UPDATE
    // inside the transaction below; that is what prevents the race where two
    // registrations consume a maxUses:1 invite concurrently (SEC-002).
    const inviteLookup = await prisma.invite.findUnique({
      where: { code: inviteCode },
      select: {
        id: true,
        scope: true,
        serverId: true,
        revokedAt: true,
        expiresAt: true,
        uses: true,
        maxUses: true,
      },
    });
    if (!inviteLookup || inviteLookup.revokedAt) {
      throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite is invalid or expired', 400);
    }
    if (inviteLookup.expiresAt && inviteLookup.expiresAt < new Date()) {
      throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite is invalid or expired', 400);
    }
    if (inviteLookup.maxUses !== null && inviteLookup.uses >= inviteLookup.maxUses) {
      throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite has been fully used', 400);
    }
    if (inviteLookup.scope === 'server' && !inviteLookup.serverId) {
      throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite is invalid or expired', 400);
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ usernameLower }, { emailLower }] },
      select: { usernameLower: true, emailLower: true },
    });
    if (existing) {
      if (existing.usernameLower === usernameLower) {
        throw TavernError.conflict(ErrorCodes.USERNAME_TAKEN, 'Username is already taken');
      }
      throw TavernError.conflict(ErrorCodes.EMAIL_TAKEN, 'Email is already registered');
    }

    const passwordHash = await hashPassword(req.password);

    const user = await prisma.$transaction(async (tx) => {
      // Atomic consume: a single conditional UPDATE that increments uses
      // only if every validity predicate still holds. Postgres serializes
      // concurrent UPDATEs on the same row, so if two registrations race
      // for a maxUses:1 invite, the second's WHERE clause will no longer
      // match and result.count comes back 0. Avoids the classic
      // check-then-act race (SEC-002).
      const result = await tx.invite.updateMany({
        where: {
          id: inviteLookup.id,
          revokedAt: null,
          scope: inviteLookup.scope,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          // maxUses is immutable for the lifetime of an invite, so reading
          // it into a literal here doesn't introduce a TOCTOU window. If
          // maxUses is null the invite has unlimited uses.
          ...(inviteLookup.maxUses !== null ? { uses: { lt: inviteLookup.maxUses } } : {}),
        },
        data: { uses: { increment: 1 } },
      });
      if (result.count === 0) {
        throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite has been fully used', 400);
      }
      const u = await tx.user.create({
        data: {
          id: ulid(),
          username: req.username,
          usernameLower,
          displayName: req.displayName,
          email: req.email,
          emailLower,
          passwordHash,
        },
      });
      if (inviteLookup.scope === 'server') {
        await tx.serverMember.create({
          data: { serverId: inviteLookup.serverId!, userId: u.id },
        });
      }
      return u;
    });

    if (this.deps.userKeyStore) {
      try {
        await this.deps.userKeyStore.ensureKeyFor(user.id);
      } catch (err) {
        (this.deps.logger ?? console).warn(
          { err, userId: user.id },
          'failed to provision federation keypair',
        );
      }
    }

    return this.issueSession(user.id, ctx);
  }

  /**
   * Returns true when there are zero users — the frontend uses this to show
   * a one-time "create admin account" page instead of the invite-gated
   * register form.
   */
  async needsBootstrap(): Promise<boolean> {
    const count = await prisma.user.count();
    return count === 0;
  }

  /**
   * First-run bootstrap. Creates the first user as instance admin, a default
   * server with @everyone + #lobby + Voice Hall, and an invite code the
   * admin can hand out. Atomic: only succeeds while User.count = 0; a
   * second concurrent call gets CONFLICT.
   */
  async bootstrap(req: BootstrapRequest, sessionCtx: SessionContext): Promise<TokenPair> {
    const usernameLower = req.username.toLowerCase();
    const emailLower = req.email.toLowerCase();

    if (req.username.length < NAME_LIMITS.MIN_USERNAME) {
      throw TavernError.validation('Username too short');
    }

    const passwordHash = await hashPassword(req.password);
    const userId = ulid();
    const serverId = ulid();
    const everyoneRoleId = ulid();
    const lobbyChannelId = ulid();
    const voiceChannelId = ulid();
    const inviteId = ulid();
    const inviteCode = generateInviteCode();
    const serverName = req.serverName?.trim() || 'The Tavern';

    // DB-013: bootstrap is a one-shot at instance creation time; two concurrent
    // calls must not both succeed. Serializable isolation makes the `count()`
    // check + the `user.create()` atomically observable as a single unit.
    await prisma.$transaction(
      async (tx) => {
        const count = await tx.user.count();
        if (count > 0) {
          throw new TavernError(
            ErrorCodes.CONFLICT,
            'This instance has already been initialised',
            409,
          );
        }

        await tx.user.create({
          data: {
            id: userId,
            username: req.username,
            usernameLower,
            displayName: req.displayName,
            email: req.email,
            emailLower,
            passwordHash,
            isInstanceAdmin: true,
          },
        });

        await tx.server.create({
          data: {
            id: serverId,
            ownerUserId: userId,
            name: serverName,
            description: 'Pull up a chair, friend.',
          },
        });
        await tx.role.create({
          data: {
            id: everyoneRoleId,
            serverId,
            name: '@everyone',
            color: 0,
            position: 0,
            isEveryone: true,
            permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
          },
        });
        await tx.server.update({
          where: { id: serverId },
          data: { defaultRoleId: everyoneRoleId },
        });
        await tx.serverMember.create({ data: { serverId, userId } });
        await tx.channel.create({
          data: {
            id: lobbyChannelId,
            serverId,
            type: 'text',
            name: 'lobby',
            topic: 'Welcome to the Tavern.',
            position: 0,
          },
        });
        await tx.channel.create({
          data: {
            id: voiceChannelId,
            serverId,
            type: 'voice',
            name: 'Voice Hall',
            position: 1,
          },
        });
        await tx.safetyPolicy.create({ data: { serverId } });

        await tx.invite.create({
          data: {
            id: inviteId,
            code: inviteCode,
            scope: 'instance',
            createdById: userId,
          },
        });

        await tx.message.create({
          data: {
            id: ulid(),
            serverId,
            channelId: lobbyChannelId,
            authorId: userId,
            type: 'system',
            content: `Welcome to ${serverName}.`,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    if (this.deps.userKeyStore) {
      try {
        await this.deps.userKeyStore.ensureKeyFor(userId);
      } catch (err) {
        (this.deps.logger ?? console).warn(
          { err, userId },
          'failed to provision federation keypair',
        );
      }
    }

    return this.issueSession(userId, sessionCtx);
  }

  async login(req: LoginRequest, ctx: SessionContext): Promise<TokenPair> {
    const identifierLower = req.identifier.toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ usernameLower: identifierLower }, { emailLower: identifierLower }],
      },
    });
    if (!user) {
      // Same error for "user not found" and "wrong password" so attackers can't enumerate.
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
    }

    if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
      // Account locked from previous failures — reject without even checking
      // the password so distributed attackers can't keep probing.
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
    }

    if (!user.passwordHash) {
      // Remote users (federation Phase 3) have no local password — reject
      // before the hash comparison to avoid leaking account existence.
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
    }
    const ok = await verifyPassword(user.passwordHash, req.password);
    if (!ok) {
      // SEC-006: keep the failed-attempt counter monotonically increasing
      // through threshold breaches. Resetting it to 0 at the threshold (the
      // previous behaviour) gave attackers 10 fresh attempts every 15 minutes
      // after the lockout expired. Now the next failure after expiry locks
      // immediately; only a successful login clears the counter.
      const nextAttempts = user.failedLoginAttempts + 1;
      const reachedThreshold = nextAttempts >= FAILED_LOGIN_LOCKOUT_THRESHOLD;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: nextAttempts,
          loginLockedUntil: reachedThreshold
            ? new Date(Date.now() + FAILED_LOGIN_LOCKOUT_MS)
            : user.loginLockedUntil,
        },
      });
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
    }

    if (user.failedLoginAttempts > 0 || user.loginLockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, loginLockedUntil: null },
      });
    }

    // Wave 2 #16 — TOTP gate. If the account has 2FA on, return a staged
    // challenge instead of a session. The client then calls
    // /api/auth/login/totp with the staged token + the user's code.
    if (user.totpEnabled) {
      const stagedToken = signStagedTotpToken(user.id, getStagedTotpKey(this.deps.config));
      throw new TotpRequiredError(stagedToken);
    }

    return this.issueSession(user.id, ctx);
  }

  /**
   * Second step of the TOTP login flow. Accepts the staged token from
   * /api/auth/login and either a TOTP code or a one-time backup code.
   *
   * SEC: every accepted TOTP code's counter is recorded so the same code
   * cannot be replayed within its 30-second window. SEC: backup-code
   * consumption uses an atomic predicate update so two concurrent calls
   * with the same code cannot both succeed. SEC: failed attempts lock the
   * account symmetric with the password step.
   */
  async loginTotp(stagedToken: string, code: string, ctx: SessionContext): Promise<TokenPair> {
    const userId = verifyStagedTotpToken(stagedToken, getStagedTotpKey(this.deps.config));
    if (!userId) {
      throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Staged token invalid or expired', 401);
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        totpSecret: true,
        totpEnabled: true,
        totpBackupCodes: true,
        totpLastCounter: true,
        failedTotpAttempts: true,
        totpLockedUntil: true,
      },
    });
    if (!user.totpEnabled || !user.totpSecret) {
      // Race: TOTP turned off between login step 1 and step 2. Restart.
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'TOTP no longer required', 400);
    }
    if (user.totpLockedUntil && user.totpLockedUntil > new Date()) {
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid code', 401);
    }
    const trimmed = code.trim();

    // Try TOTP first. Replay-guard: reject if the matched counter is at or
    // below the last accepted one — that means the same code already
    // unlocked a session within the same 30-second window.
    const totpResult = verifyTotpWithCounter(user.totpSecret, trimmed);
    if (totpResult) {
      const matchedCounter = BigInt(totpResult.counter);
      const lastCounter = BigInt(user.totpLastCounter);
      if (matchedCounter <= lastCounter) {
        // Replay — treat as a failed attempt so the lockout still tightens.
        await this.recordFailedTotpAttempt(user.id, user.failedTotpAttempts);
        throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid code', 401);
      }
      // Atomically advance the counter so a parallel call with the same code
      // can't also pass this check. updateMany with the counter predicate
      // returns 0 on a race; treat that as a failed attempt.
      const advanced = await prisma.user.updateMany({
        where: { id: user.id, totpLastCounter: user.totpLastCounter },
        data: {
          totpLastCounter: matchedCounter,
          failedTotpAttempts: 0,
          totpLockedUntil: null,
        },
      });
      if (advanced.count !== 1) {
        await this.recordFailedTotpAttempt(user.id, user.failedTotpAttempts);
        throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid code', 401);
      }
      return this.issueSession(user.id, ctx);
    }

    // Fall through to backup-code path. Atomic consumption: we recompute the
    // remaining list ourselves but write it conditional on the array still
    // matching what we read, which makes the read-modify-write idempotent.
    const backup = Array.isArray(user.totpBackupCodes) ? (user.totpBackupCodes as string[]) : [];
    const provided = hashBackupCode(trimmed);
    const idx = backup.indexOf(provided);
    if (idx >= 0) {
      const remaining = backup.filter((_, i) => i !== idx);
      const consumed = await prisma.user.updateMany({
        where: { id: user.id, totpBackupCodes: { equals: backup } },
        data: {
          totpBackupCodes: remaining,
          failedTotpAttempts: 0,
          totpLockedUntil: null,
        },
      });
      if (consumed.count !== 1) {
        // Two concurrent loginTotp with the same backup code raced — only one
        // can win. The loser is indistinguishable from a wrong code.
        await this.recordFailedTotpAttempt(user.id, user.failedTotpAttempts);
        throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid code', 401);
      }
      return this.issueSession(user.id, ctx);
    }

    await this.recordFailedTotpAttempt(user.id, user.failedTotpAttempts);
    throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid code', 401);
  }

  /**
   * Increment `failedTotpAttempts`. At the threshold we set `totpLockedUntil`
   * so subsequent calls are rejected up front. Best-effort: a DB hiccup here
   * shouldn't turn a wrong-code response into a 500.
   */
  private async recordFailedTotpAttempt(userId: string, currentAttempts: number): Promise<void> {
    const next = currentAttempts + 1;
    const reached = next >= FAILED_TOTP_LOCKOUT_THRESHOLD;
    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedTotpAttempts: next,
          totpLockedUntil: reached ? new Date(Date.now() + FAILED_TOTP_LOCKOUT_MS) : undefined,
        },
      });
    } catch {
      /* swallow — caller is already returning INVALID_CREDENTIALS */
    }
  }

  async refresh(refreshToken: string, ctx: SessionContext): Promise<TokenPair> {
    const payload = await this.deps.jwt.verifyRefresh(refreshToken);

    const session = await prisma.session.findUnique({
      where: { id: payload.sid },
    });
    if (!session) throw TavernError.unauthorized('Session not found');
    if (session.revokedAt) {
      // Reuse detection: revoke all sessions for this user. (Best-effort.)
      await prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Refresh token reuse detected', 401);
    }
    if (session.expiresAt < new Date()) {
      throw new TavernError(ErrorCodes.EXPIRED_TOKEN, 'Refresh token expired', 401);
    }
    // Timing-safe equality on the SHA-256 hex of the presented token. The
    // hashes are fixed length so leakage from `!==` short-circuiting is
    // theoretical, but timingSafeEqual is the right primitive here and
    // costs nothing.
    const presentedHash = sha256(refreshToken);
    const storedHashBuf = Buffer.from(session.refreshTokenHash, 'hex');
    const presentedHashBuf = Buffer.from(presentedHash, 'hex');
    if (
      storedHashBuf.length !== presentedHashBuf.length ||
      !crypto.timingSafeEqual(storedHashBuf, presentedHashBuf)
    ) {
      throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Refresh token does not match session', 401);
    }
    // SEC: re-check the user's lifecycle state on every refresh. A
    // scheduledDeleteAt in the past means the account is past its grace
    // window and should be considered deleted — minting fresh access tokens
    // for it would be a privilege-escalation against the deletion job.
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, scheduledDeleteAt: true },
    });
    if (!user || (user.scheduledDeleteAt && user.scheduledDeleteAt < new Date())) {
      // Burn the session so subsequent refresh attempts also fail fast.
      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw TavernError.unauthorized('Account no longer active');
    }

    // Rotate: revoke this session and issue a new one.
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issueSession(session.userId, ctx);
  }

  async logout(sessionId: string): Promise<void> {
    await prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Step 1 of self-service password reset (Wave 3).
   *
   * Always resolves successfully regardless of whether the supplied email
   * matches an account — the caller surfaces a generic "if we found your
   * email, a link is on its way" response so attackers can't enumerate
   * which addresses are registered. Mail dispatch is fire-and-forget for
   * the same reason (a slow-or-failed SMTP path must not become a timing
   * oracle).
   *
   * A short per-user cooldown prevents an attacker from carpet-bombing a
   * single mailbox: if there's an unused, unexpired reset row newer than
   * the cooldown, we reuse silence rather than mint a second token.
   */
  async forgotPassword(email: string, ctx: SessionContext): Promise<void> {
    const emailLower = email.trim().toLowerCase();
    if (!emailLower) return;
    const user = await prisma.user.findUnique({
      where: { emailLower },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) return;

    // Per-user cooldown: don't mint another token if a recent one is still
    // outstanding. Sixty seconds is short enough that real users hitting
    // "resend" feel responsive and long enough to defang a flood.
    const cooldownMs = 60_000;
    const recent = await prisma.passwordReset.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        createdAt: { gt: new Date(Date.now() - cooldownMs) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (recent) return;

    const ttl = this.deps.config.PASSWORD_RESET_TTL_SECONDS;
    // 32 random bytes → 64 hex characters. Plenty of entropy; readable in
    // URLs; matches the existing `randomTokenHex` helper.
    const token = randomTokenHex(32);
    const tokenHash = sha256(token);

    await prisma.passwordReset.create({
      data: {
        id: ulid(),
        userId: user.id,
        tokenHash,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
    });

    const link = this.buildResetLink(token);
    const { subject, text, html } = renderResetEmail({
      displayName: user.displayName,
      link,
      ttlMinutes: Math.round(ttl / 60),
    });

    // Fire-and-forget: mail dispatch must not block the HTTP response (it
    // would otherwise become a side-channel for "this address exists"
    // based on timing).
    void this.deps.mail.send({ to: user.email, subject, text, html }).catch(() => undefined);
  }

  /**
   * Step 2 of self-service password reset (Wave 3).
   *
   * Consumes a reset token, rewrites the password hash, and revokes every
   * active session for the user — same posture as `changePassword`. Also
   * invalidates every other outstanding reset token for that user so a
   * single compromised mailbox doesn't yield a pile of replays.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = sha256(token);
    const reset = await prisma.passwordReset.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new TavernError(
        ErrorCodes.INVALID_RESET_TOKEN,
        'Reset link is invalid or has expired',
        400,
      );
    }
    const user = await prisma.user.findUnique({
      where: { id: reset.userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) {
      throw new TavernError(
        ErrorCodes.INVALID_RESET_TOKEN,
        'Reset link is invalid or has expired',
        400,
      );
    }
    // Remote users have no local password — they cannot reset via this path.
    if (!user.passwordHash) {
      throw new TavernError(
        ErrorCodes.INVALID_RESET_TOKEN,
        'Reset link is invalid or has expired',
        400,
      );
    }
    // Refuse no-op resets so the user gets an explicit signal rather than
    // a misleading success when they reuse their old password.
    const sameAsCurrent = await verifyPassword(user.passwordHash, newPassword);
    if (sameAsCurrent) {
      throw TavernError.validation('New password must differ from current password');
    }
    const nextHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: nextHash, failedLoginAttempts: 0, loginLockedUntil: null },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Burn every outstanding reset token for this user — both the one we
      // just consumed and any siblings — so the credential change can't be
      // replayed by anyone holding a parallel link.
      await tx.passwordReset.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
    });
  }

  private buildResetLink(token: string): string {
    const base = this.deps.config.WEB_BASE_URL.replace(/\/+$/, '');
    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
  }

  /**
   * Change a user's password while logged in (SEC-003).
   *
   * Verifies the current password (so an XSS/CSRF or a stolen access token
   * cannot silently rotate the credential), then rewrites the Argon2 hash
   * and revokes every active session for the user. The current session is
   * not exempted — the caller must re-authenticate after a successful
   * change. Same `INVALID_CREDENTIALS` error code as login so attackers
   * can't enumerate which accounts still hold the original password.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (newPassword === currentPassword) {
      throw TavernError.validation('New password must differ from current password');
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) throw TavernError.unauthorized();
    if (!user.passwordHash) {
      // Remote users (federation Phase 3) have no local password.
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
    }
    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
    }
    const nextHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: nextHash },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /**
   * Public entry point for non-password authentication paths (currently the
   * WebAuthn assertion verifier). The caller has already proven the user's
   * identity via a second-factor flow; we just need to mint the session
   * pair with the same posture as a password login.
   */
  async issueWebauthnSession(userId: string, ctx: SessionContext): Promise<TokenPair> {
    return this.issueSession(userId, ctx);
  }

  private async issueSession(userId: string, ctx: SessionContext): Promise<TokenPair> {
    const sessionId = ulid();
    const refreshTtl = this.deps.config.REFRESH_TOKEN_TTL_SECONDS ?? TOKEN_TTL.REFRESH_SECONDS;

    const refresh = await this.deps.jwt.signRefresh({
      sub: userId,
      sid: sessionId,
      typ: 'refresh',
      jti: ulid(),
    });

    await prisma.session.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash: sha256(refresh.token),
        deviceName: ctx.deviceName ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    // SEC-009: enforce a per-user active-session cap. If this user now has
    // more than MAX_ACTIVE_SESSIONS_PER_USER unrevoked sessions, revoke the
    // oldest ones. Fire-and-forget so the happy path isn't blocked; a
    // failure here just leaves the next /me / /refresh to do it.
    void this.pruneOldestSessions(userId).catch(() => undefined);

    const access = await this.deps.jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  }

  /**
   * Revoke any sessions for this user beyond the cap, oldest-first. Cheap when
   * the user is under the cap (a single COUNT). SEC-009.
   */
  private async pruneOldestSessions(userId: string): Promise<void> {
    const active = await prisma.session.count({ where: { userId, revokedAt: null } });
    if (active <= MAX_ACTIVE_SESSIONS_PER_USER) return;
    const overflow = active - MAX_ACTIVE_SESSIONS_PER_USER;
    const oldest = await prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      take: overflow,
      select: { id: true },
    });
    if (oldest.length === 0) return;
    await prisma.session.updateMany({
      where: { id: { in: oldest.map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });
  }
}

interface ResetEmailOpts {
  displayName: string;
  link: string;
  ttlMinutes: number;
}

interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render the password-reset email. Plain-text body is the source of truth
 * for mail clients that don't render HTML; the HTML body mirrors it with
 * a clickable link. Subject + body are deliberately neutral — they avoid
 * confirming the recipient owns the account (the email itself does that).
 */
function renderResetEmail(opts: ResetEmailOpts): RenderedMail {
  const subject = 'Reset your Tavern password';
  const text = [
    `Hi ${opts.displayName},`,
    '',
    'Someone (hopefully you) asked to reset the password on your Tavern',
    'account. To choose a new one, open this link within the next',
    `${opts.ttlMinutes} minutes:`,
    '',
    opts.link,
    '',
    'If you did not request a reset, you can ignore this message — your',
    'password will stay the same.',
  ].join('\n');
  const safeLink = escapeHtml(opts.link);
  const safeName = escapeHtml(opts.displayName);
  const html = [
    `<p>Hi ${safeName},</p>`,
    '<p>Someone (hopefully you) asked to reset the password on your Tavern account. ',
    `To choose a new one, open the link below within the next ${opts.ttlMinutes} minutes:</p>`,
    `<p><a href="${safeLink}">${safeLink}</a></p>`,
    '<p>If you did not request a reset, you can ignore this message — your password will stay the same.</p>',
  ].join('');
  return { subject, text, html };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
