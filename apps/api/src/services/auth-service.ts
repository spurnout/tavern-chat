import { prisma } from '@tavern/db';
import {
  ErrorCodes,
  NAME_LIMITS,
  TavernError,
  TOKEN_TTL,
  ulid,
  type LoginRequest,
  type RegisterRequest,
  type TokenPair,
} from '@tavern/shared';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { sha256 } from '../lib/hash.js';
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

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async register(req: RegisterRequest, ctx: SessionContext): Promise<TokenPair> {
    const usernameLower = req.username.toLowerCase();
    const emailLower = req.email.toLowerCase();

    if (usernameLower.length < NAME_LIMITS.MIN_USERNAME) {
      throw TavernError.validation('Username too short');
    }

    const invite = await prisma.invite.findUnique({
      where: { code: req.inviteCode },
    });
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt < new Date())) {
      throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite is invalid or expired', 400);
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw new TavernError(ErrorCodes.INVALID_INVITE, 'Invite has been fully used', 400);
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
      await tx.invite.update({
        where: { id: invite.id },
        data: { uses: { increment: 1 } },
      });
      return u;
    });

    return this.issueSession(user.id, ctx);
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
    const ok = await verifyPassword(user.passwordHash, req.password);
    if (!ok) {
      throw new TavernError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
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

    const access = await this.deps.jwt.signAccess({ sub: userId, sid: sessionId, typ: 'access' });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  }
}
