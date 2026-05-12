import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { TavernError, ErrorCodes } from '@tavern/shared';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  typ: 'refresh';
  jti: string;
}

interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  issuer?: string;
}

const DEFAULT_ISSUER = 'tavern';
/**
 * Audience claim for access tokens. Distinct from refresh-token audience so a
 * stolen refresh token can't be replayed as an access token even if a future
 * change accidentally cross-validates against the wrong key. SEC-005.
 */
const ACCESS_AUDIENCE = 'tavern-api';
const REFRESH_AUDIENCE = 'tavern-refresh';

export class JwtService {
  private readonly accessKey: Uint8Array;
  private readonly refreshKey: Uint8Array;
  private readonly issuer: string;

  constructor(private readonly cfg: JwtConfig) {
    this.accessKey = new TextEncoder().encode(cfg.accessSecret);
    this.refreshKey = new TextEncoder().encode(cfg.refreshSecret);
    this.issuer = cfg.issuer ?? DEFAULT_ISSUER;
  }

  async signAccess(payload: AccessTokenPayload): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.cfg.accessTtlSeconds * 1000);
    const token = await new SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setIssuer(this.issuer)
      .setAudience(ACCESS_AUDIENCE)
      .sign(this.accessKey);
    return { token, expiresAt };
  }

  async signRefresh(payload: RefreshTokenPayload): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.cfg.refreshTtlSeconds * 1000);
    const token = await new SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setIssuer(this.issuer)
      .setAudience(REFRESH_AUDIENCE)
      .sign(this.refreshKey);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AccessTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.accessKey, {
        issuer: this.issuer,
        audience: ACCESS_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw TavernError.unauthorized('Malformed token');
      }
      return { sub: payload.sub, sid: payload.sid, typ: 'access' };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new TavernError(ErrorCodes.EXPIRED_TOKEN, 'Access token expired', 401);
      }
      if (err instanceof TavernError) throw err;
      throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Invalid access token', 401);
    }
  }

  async verifyRefresh(token: string): Promise<RefreshTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.refreshKey, {
        issuer: this.issuer,
        audience: REFRESH_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        payload.typ !== 'refresh' ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.jti !== 'string'
      ) {
        throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Malformed refresh token', 401);
      }
      return { sub: payload.sub, sid: payload.sid, jti: payload.jti, typ: 'refresh' };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new TavernError(ErrorCodes.EXPIRED_TOKEN, 'Refresh token expired', 401);
      }
      if (err instanceof TavernError) throw err;
      throw new TavernError(ErrorCodes.INVALID_TOKEN, 'Invalid refresh token', 401);
    }
  }
}
