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
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { sha256 } from '../lib/hash.js';
import { generateInviteCode } from '../lib/invite-codes.js';
import type { JwtService } from '../lib/jwt.js';
import type { Config } from '../config.js';

export interface AuthServiceDeps {
  jwt: JwtService;
  config: Config;
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

    if (usernameLower.length < NAME_LIMITS.MIN_USERNAME) {
      throw TavernError.validation('Username too short');
    }

    // Pre-flight invite check — surfaces "invite is invalid" before we spend
    // CPU on the Argon2 hash. The authoritative check is the atomic UPDATE
    // inside the transaction below; that is what prevents the race where two
    // registrations consume a maxUses:1 invite concurrently (SEC-002).
    const inviteLookup = await prisma.invite.findUnique({
      where: { code: req.inviteCode },
      select: { id: true, scope: true, revokedAt: true, expiresAt: true, uses: true, maxUses: true },
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
    // Server-scoped invites are for adding existing users to a server; they
    // are not registration tickets. Only instance-scoped invites may be used
    // to create an account (SEC-018).
    if (inviteLookup.scope !== 'instance') {
      throw new TavernError(
        ErrorCodes.INVALID_INVITE,
        'This invite cannot be used for registration',
        400,
      );
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
          scope: 'instance',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          // maxUses is immutable for the lifetime of an invite, so reading
          // it into a literal here doesn't introduce a TOCTOU window. If
          // maxUses is null the invite has unlimited uses.
          ...(inviteLookup.maxUses !== null
            ? { uses: { lt: inviteLookup.maxUses } }
            : {}),
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
      return u;
    });

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
  async bootstrap(
    req: BootstrapRequest,
    sessionCtx: SessionContext,
  ): Promise<TokenPair> {
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
      throw new TavernError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        401,
      );
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

    return this.issueSession(user.id, ctx);
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
    if (session.refreshTokenHash !== sha256(refreshToken)) {
      throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Refresh token does not match session', 401);
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
