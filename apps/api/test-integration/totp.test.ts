/**
 * Integration coverage for the TOTP 2FA management surface in
 * `apps/api/src/routes/totp.ts`, exercised end-to-end against a real
 * Postgres testcontainer via `app.inject`.
 *
 * Routes covered:
 *   GET  /api/me/totp              — read 2FA status
 *   POST /api/me/totp/setup        — stage secret (totpEnabled stays false)
 *   POST /api/me/totp/verify       — confirm code → flip totpEnabled + mint backup codes
 *   POST /api/me/totp/disable      — confirm code (TOTP or backup) → clear 2FA state
 *   POST /api/me/totp/backup-codes — regenerate backup codes
 *
 * TOTP code generation uses the same in-house RFC-6238 implementation that the
 * production code uses (`apps/api/src/lib/totp.ts`), so there is no additional
 * test-only dependency. The `base32Decode` + `hotp` helpers are imported
 * directly from the source lib.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { ulid } from '@tavern/shared';
import {
  isDockerAvailable,
  resetDb,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { base32Decode } from '../src/lib/totp.js';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeUser(slug: string): Promise<string> {
  const id = ulid();
  const uname = `${slug}-${id.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username: uname,
      usernameLower: uname,
      displayName: uname,
      email: `${uname}@example.test`,
      emailLower: `${uname}@example.test`,
      passwordHash: 'x',
    },
  });
  return id;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
  } as NodeJS.ProcessEnv;
}

async function buildTestApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envFor(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

type OkBody<T> = { ok: true; data: T };

/**
 * Generate the current RFC-6238 TOTP code for the given base32 secret.
 * Uses the same HOTP primitive logic that the production verifier uses,
 * re-implemented here directly so no external dependency is introduced.
 */
function generateTotpCode(secret: string): string {
  const secretBuf = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** 6).toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('TOTP 2FA routes (apps/api/src/routes/totp.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // -------------------------------------------------------------------------
  // GET /api/me/totp
  // -------------------------------------------------------------------------

  it('GET /api/me/totp — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/totp' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/totp — returns enabled:false and 0 backup codes for a fresh user', async () => {
    const userId = await makeUser('freshuser');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/totp',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ enabled: boolean; backupCodesRemaining: number }>;
      expect(body.ok).toBe(true);
      expect(body.data.enabled).toBe(false);
      expect(body.data.backupCodesRemaining).toBe(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/me/totp/setup
  // -------------------------------------------------------------------------

  it('POST /api/me/totp/setup — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/me/totp/setup' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/setup — returns secret + otpauthUrl, stages secret in DB (totpEnabled stays false)', async () => {
    const userId = await makeUser('setupuser');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ secret: string; otpauthUrl: string }>;
      expect(body.ok).toBe(true);
      expect(typeof body.data.secret).toBe('string');
      expect(body.data.secret.length).toBeGreaterThan(0);
      expect(body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

      // The secret is staged on the user row, but totpEnabled is still false.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpSecret: true, totpEnabled: true },
      });
      expect(row.totpSecret).toBe(body.data.secret);
      expect(row.totpEnabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/setup — 400 when 2FA is already enabled', async () => {
    const userId = await makeUser('alreadyenabled');
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpSecret: 'FAKESECRET' },
    });
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/me/totp/verify
  // -------------------------------------------------------------------------

  it('POST /api/me/totp/verify — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/verify — 400 when setup was never called (no totpSecret)', async () => {
    const userId = await makeUser('nosecretu');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/verify — 400 with a wrong code (INVALID_CREDENTIALS)', async () => {
    const userId = await makeUser('wrongcode');
    const token = await mintToken(userId);
    // Stage a secret via setup endpoint.
    const app = await buildTestApp();
    try {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(setupRes.statusCode).toBe(200);

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '000000' }, // almost certainly wrong
      });
      expect(verifyRes.statusCode).toBe(400);

      // totpEnabled must still be false.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpEnabled: true },
      });
      expect(row.totpEnabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/verify — 200 with a valid code: enables 2FA, mints backup codes', async () => {
    const userId = await makeUser('validcode');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      // 1. Setup — get the staged secret.
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(setupRes.statusCode).toBe(200);
      const { data: setupData } = setupRes.json() as OkBody<{
        secret: string;
        otpauthUrl: string;
      }>;

      // 2. Generate a valid code from the returned secret.
      const code = generateTotpCode(setupData.secret);

      // 3. Verify.
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code },
      });
      expect(verifyRes.statusCode).toBe(200);
      const body = verifyRes.json() as OkBody<{ enabled: boolean; backupCodes: string[] }>;
      expect(body.data.enabled).toBe(true);
      expect(Array.isArray(body.data.backupCodes)).toBe(true);
      expect(body.data.backupCodes.length).toBe(10);

      // DB must reflect the change.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpEnabled: true, totpBackupCodes: true },
      });
      expect(row.totpEnabled).toBe(true);
      const storedCodes = row.totpBackupCodes as string[];
      expect(storedCodes.length).toBe(10);
      // Stored copies must be hashed (not equal to the plaintext ones).
      const plaintext = body.data.backupCodes;
      for (const plain of plaintext) {
        expect(storedCodes).not.toContain(plain);
      }
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/verify — 400 when 2FA is already enabled', async () => {
    const userId = await makeUser('alreadyon');
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpSecret: 'FAKESECRET' },
    });
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/verify — 400 when code body is too short (schema validation)', async () => {
    const userId = await makeUser('shortcode');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '123' }, // min(6) fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/me/totp/disable
  // -------------------------------------------------------------------------

  it('POST /api/me/totp/disable — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/disable',
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/disable — 400 when 2FA is not enabled', async () => {
    const userId = await makeUser('nodisable');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/disable',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/disable — 400 with a wrong code', async () => {
    const userId = await makeUser('wrongdisable');
    // Manually enable 2FA with a known secret so we can test the rejection.
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' },
    });
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/disable',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(400);
      // 2FA must still be enabled.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpEnabled: true },
      });
      expect(row.totpEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/disable — 200 with a valid TOTP code, clears all 2FA state', async () => {
    const userId = await makeUser('disablevalid');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      // Enroll via setup + verify.
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(setupRes.statusCode).toBe(200);
      const { data: setupData } = setupRes.json() as OkBody<{ secret: string }>;
      const verifyCode = generateTotpCode(setupData.secret);
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: verifyCode },
      });
      expect(verifyRes.statusCode).toBe(200);

      // Generate a fresh code (same slot or next — both within window).
      const disableCode = generateTotpCode(setupData.secret);
      const disableRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/disable',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: disableCode },
      });
      expect(disableRes.statusCode).toBe(200);
      const body = disableRes.json() as OkBody<{ enabled: boolean }>;
      expect(body.data.enabled).toBe(false);

      // DB must be fully cleared.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpEnabled: true, totpSecret: true, totpBackupCodes: true },
      });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecret).toBeNull();
      expect(row.totpBackupCodes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/disable — 200 using a valid backup code', async () => {
    const userId = await makeUser('backupdisable');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      // Enroll fully to get plaintext backup codes.
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(setupRes.statusCode).toBe(200);
      const { data: setupData } = setupRes.json() as OkBody<{ secret: string }>;
      const verifyCode = generateTotpCode(setupData.secret);
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: verifyCode },
      });
      expect(verifyRes.statusCode).toBe(200);
      const { data: verifyData } = verifyRes.json() as OkBody<{ backupCodes: string[] }>;
      const backupCode = verifyData.backupCodes[0]!;

      // Disable using a backup code (not a TOTP code).
      const disableRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/disable',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: backupCode },
      });
      expect(disableRes.statusCode).toBe(200);
      const body = disableRes.json() as OkBody<{ enabled: boolean }>;
      expect(body.data.enabled).toBe(false);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpEnabled: true, totpSecret: true },
      });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecret).toBeNull();
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/me/totp/backup-codes (regenerate)
  // -------------------------------------------------------------------------

  it('POST /api/me/totp/backup-codes — 401 when no token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/backup-codes',
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/backup-codes — 400 when 2FA is not enabled', async () => {
    const userId = await makeUser('nobackup');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/backup-codes',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/backup-codes — 400 with a wrong code', async () => {
    const userId = await makeUser('wrongbackup');
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' },
    });
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/totp/backup-codes',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/totp/backup-codes — 200 with valid code: new backup codes replace the old ones', async () => {
    const userId = await makeUser('regen');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      // Enroll fully.
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      const { data: setupData } = setupRes.json() as OkBody<{ secret: string }>;
      const verifyCode = generateTotpCode(setupData.secret);
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: verifyCode },
      });
      expect(verifyRes.statusCode).toBe(200);
      const { data: verifyData } = verifyRes.json() as OkBody<{ backupCodes: string[] }>;
      const originalBackupCodes = verifyData.backupCodes;

      // Regenerate.
      const regenCode = generateTotpCode(setupData.secret);
      const regenRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/backup-codes',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: regenCode },
      });
      expect(regenRes.statusCode).toBe(200);
      const { data: regenData } = regenRes.json() as OkBody<{ backupCodes: string[] }>;
      expect(Array.isArray(regenData.backupCodes)).toBe(true);
      expect(regenData.backupCodes.length).toBe(10);

      // New codes must not be the same set as the originals.
      const overlap = originalBackupCodes.filter((c) => regenData.backupCodes.includes(c));
      expect(overlap.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // End-to-end: GET after enable reflects new state
  // -------------------------------------------------------------------------

  it('GET /api/me/totp after enabling reflects enabled:true and backupCodesRemaining:10', async () => {
    const userId = await makeUser('statuscheck');
    const token = await mintToken(userId);
    const app = await buildTestApp();
    try {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/me/totp/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      const { data: setupData } = setupRes.json() as OkBody<{ secret: string }>;
      const code = generateTotpCode(setupData.secret);
      await app.inject({
        method: 'POST',
        url: '/api/me/totp/verify',
        headers: { authorization: `Bearer ${token}` },
        payload: { code },
      });

      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/me/totp',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(statusRes.statusCode).toBe(200);
      const body = statusRes.json() as OkBody<{
        enabled: boolean;
        backupCodesRemaining: number;
      }>;
      expect(body.data.enabled).toBe(true);
      expect(body.data.backupCodesRemaining).toBe(10);
    } finally {
      await app.close();
    }
  });
});
