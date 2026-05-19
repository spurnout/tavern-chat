import { describe, expect, it } from 'vitest';
import {
  getStagedTotpKey,
  signStagedTotpToken,
  verifyStagedTotpToken,
} from '../src/services/auth-service.js';
import type { Config } from '../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    APP_NAME: 'TavernTest',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    PUBLIC_BASE_URL: 'http://localhost:3001',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: undefined,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    STAGED_TOTP_SECRET: undefined,
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
    ALLOWED_ORIGINS: 'http://localhost:3030',
    OG_FETCH_ENABLED: false,
    ALLOW_PUBLIC_REGISTRATION: false,
    TRUST_PROXY: undefined,
    TRUST_SAFETY_CORE_ENABLED: true,
    CLAMAV_HOST: undefined,
    CLAMAV_PORT: 3310,
    ALLOW_UNSCANNED_UPLOADS: true,
    BLOCK_EXECUTABLE_UPLOADS: true,
    BLOCK_ARCHIVE_UPLOADS: true,
    STRIP_IMAGE_METADATA: true,
    MAX_MESSAGE_LENGTH: 4000,
    STORAGE_BACKEND: 'local',
    LOCAL_STORAGE_DIR: './data/storage',
    S3_ENDPOINT: undefined,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: undefined,
    S3_SECRET_KEY: undefined,
    S3_BUCKET: 'tavern-media',
    S3_QUARANTINE_BUCKET: 'tavern-quarantine',
    S3_USE_SSL: false,
    LIVEKIT_URL: undefined,
    LIVEKIT_API_KEY: undefined,
    LIVEKIT_API_SECRET: undefined,
    LOG_LEVEL: 'info',
    S3_PRESIGN_EXPIRY_SECONDS: 600,
    UPLOAD_MAX_BYTES: 100 * 1024 * 1024,
    WEB_BASE_URL: 'http://localhost:3030',
    SMTP_HOST: undefined,
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_FROM: undefined,
    PASSWORD_RESET_TTL_SECONDS: 3600,
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: undefined,
    WEBAUTHN_ORIGIN: undefined,
    LLM_ENDPOINT: undefined,
    LLM_API_KEY: undefined,
    LLM_MODEL: 'gpt-4o-mini',
    OIDC_ISSUER_URL: undefined,
    OIDC_CLIENT_ID: undefined,
    OIDC_CLIENT_SECRET: undefined,
    OIDC_REDIRECT_URI: undefined,
    OIDC_BUTTON_LABEL: 'Sign in with SSO',
    ...overrides,
  };
}

describe('getStagedTotpKey', () => {
  it('prefers STAGED_TOTP_SECRET when set with sufficient length', () => {
    const key = 'c'.repeat(48);
    expect(getStagedTotpKey(makeConfig({ STAGED_TOTP_SECRET: key }))).toBe(key);
  });

  it('falls back to a derived label when STAGED_TOTP_SECRET is unset', () => {
    const cfg = makeConfig({ STAGED_TOTP_SECRET: undefined });
    const fallback = getStagedTotpKey(cfg);
    expect(fallback).toContain(cfg.JWT_ACCESS_SECRET);
    expect(fallback).not.toBe(cfg.JWT_ACCESS_SECRET);
  });

  it('falls back to derived label when STAGED_TOTP_SECRET is too short', () => {
    const cfg = makeConfig({ STAGED_TOTP_SECRET: 'short' });
    const fallback = getStagedTotpKey(cfg);
    expect(fallback).not.toBe('short');
  });

  it('produces different staged tokens for dedicated vs fallback keys', () => {
    // Without the dedicated secret, an attacker who knows JWT_ACCESS_SECRET
    // can compute the staged-token key. Setting STAGED_TOTP_SECRET must
    // produce a different HMAC so existing JWT keys can't forge staged
    // tokens for the new deployment.
    const cfgFallback = makeConfig({ STAGED_TOTP_SECRET: undefined });
    const cfgDedicated = makeConfig({ STAGED_TOTP_SECRET: 'd'.repeat(48) });

    const tokenFallback = signStagedTotpToken('user_xyz', getStagedTotpKey(cfgFallback));
    const tokenDedicated = signStagedTotpToken('user_xyz', getStagedTotpKey(cfgDedicated));

    expect(tokenFallback).not.toBe(tokenDedicated);

    // Cross-verification must fail — a token signed with one key must NOT
    // verify with the other.
    expect(verifyStagedTotpToken(tokenFallback, getStagedTotpKey(cfgDedicated))).toBeNull();
    expect(verifyStagedTotpToken(tokenDedicated, getStagedTotpKey(cfgFallback))).toBeNull();

    // Round-trips through the correct key still succeed.
    expect(verifyStagedTotpToken(tokenFallback, getStagedTotpKey(cfgFallback))).toBe('user_xyz');
    expect(verifyStagedTotpToken(tokenDedicated, getStagedTotpKey(cfgDedicated))).toBe('user_xyz');
  });
});

describe('signStagedTotpToken / verifyStagedTotpToken', () => {
  it('round-trips a userId through sign-verify', () => {
    const key = 'k'.repeat(48);
    const token = signStagedTotpToken('user_abc', key);
    expect(verifyStagedTotpToken(token, key)).toBe('user_abc');
  });

  it('returns null when the signature is tampered', () => {
    const key = 'k'.repeat(48);
    const token = signStagedTotpToken('user_abc', key);
    const tampered = token.slice(0, -4) + 'XXXX';
    expect(verifyStagedTotpToken(tampered, key)).toBeNull();
  });

  it('returns null when the userId portion is swapped', () => {
    const key = 'k'.repeat(48);
    const token = signStagedTotpToken('user_abc', key);
    const parts = token.split('.');
    // Re-assemble with a different userId but the same signature.
    parts[1] = 'user_evil';
    expect(verifyStagedTotpToken(parts.join('.'), key)).toBeNull();
  });

  it('returns null after the 5-minute TTL elapses', () => {
    const key = 'k'.repeat(48);
    // Build a token with an explicit past `expires` field — we can't easily
    // mock Date.now inside the auth-service module, but we can hand-craft a
    // token in the same format and assert the verifier rejects it.
    const expires = Date.now() - 1_000;
    const payload = `1.user_abc.${expires}`;
    const crypto = require('node:crypto');
    const sig = crypto
      .createHmac('sha256', `tvn-totp-stage:${key}`)
      .update(payload)
      .digest('base64url');
    const expiredToken = `${payload}.${sig}`;
    expect(verifyStagedTotpToken(expiredToken, key)).toBeNull();
  });
});
