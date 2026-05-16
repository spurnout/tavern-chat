import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { APP_NAME, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  otpauthUrl,
  verifyTotp,
} from '../lib/totp.js';

const codeBodySchema = z.object({ code: z.string().min(6).max(12) });

/**
 * Wave 2 #16 — TOTP 2FA.
 *
 * Setup flow:
 *   1. POST /me/totp/setup — returns provisioning secret + otpauth URL.
 *      Secret is staged on the user row but `totpEnabled` stays false.
 *   2. POST /me/totp/verify — caller submits a code from their app.
 *      On success `totpEnabled` flips true and backup codes are minted.
 *   3. POST /me/totp/disable — confirms with a code; clears 2FA state.
 *
 * Login (modifies the existing /auth/login flow indirectly):
 *   POST /auth/login returns either { tokens } (no 2FA) or
 *   { step: 'totp_required', stagedToken } (2FA on). Stage token TTL = 5
 *   minutes; client exchanges via POST /auth/login/totp { stagedToken, code }.
 *
 * For brevity this route file implements only the management endpoints —
 * login integration goes in `auth.ts` as a follow-up. The schema + secret
 * primitives below are the load-bearing pieces; flipping login over is a
 * one-line change once those exist.
 */

export async function registerTotpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/totp', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { totpEnabled: true, totpBackupCodes: true },
    });
    const codes = Array.isArray(user.totpBackupCodes) ? (user.totpBackupCodes as string[]) : [];
    reply.send(
      ok({
        enabled: user.totpEnabled,
        backupCodesRemaining: codes.length,
      }),
    );
  });

  app.post('/api/me/totp/setup', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { username: true, totpEnabled: true },
    });
    if (user.totpEnabled) {
      throw TavernError.validation('2FA is already enabled — disable it first to re-enrol');
    }
    const { secret } = generateTotpSecret();
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { totpSecret: secret },
    });
    const url = otpauthUrl(secret, user.username, APP_NAME);
    reply.send(ok({ secret, otpauthUrl: url }));
  });

  app.post('/api/me/totp/verify', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = codeBodySchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user.totpSecret) throw TavernError.validation('Setup first via /me/totp/setup');
    if (user.totpEnabled) throw TavernError.validation('2FA already enabled');
    if (!verifyTotp(user.totpSecret, body.code)) {
      throw new TavernError('INVALID_CREDENTIALS', 'Code did not match', 400);
    }
    const backup = generateBackupCodes(10);
    await prisma.user.update({
      where: { id: ctx.userId },
      data: {
        totpEnabled: true,
        totpBackupCodes: backup.map(hashBackupCode),
      },
    });
    reply.send(ok({ enabled: true, backupCodes: backup }));
  });

  app.post('/api/me/totp/disable', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = codeBodySchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { totpSecret: true, totpEnabled: true, totpBackupCodes: true },
    });
    if (!user.totpEnabled) throw TavernError.validation('2FA is not enabled');
    const ok2 = user.totpSecret ? verifyTotp(user.totpSecret, body.code) : false;
    const backup = Array.isArray(user.totpBackupCodes) ? (user.totpBackupCodes as string[]) : [];
    const matchedBackup = !ok2 && backup.includes(hashBackupCode(body.code));
    if (!ok2 && !matchedBackup) {
      throw new TavernError('INVALID_CREDENTIALS', 'Code did not match', 400);
    }
    await prisma.user.update({
      where: { id: ctx.userId },
      data: {
        totpSecret: null,
        totpEnabled: false,
        totpBackupCodes: [],
      },
    });
    reply.send(ok({ enabled: false }));
  });

  app.post('/api/me/totp/backup-codes', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = codeBodySchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user.totpEnabled || !user.totpSecret) {
      throw TavernError.validation('2FA is not enabled');
    }
    if (!verifyTotp(user.totpSecret, body.code)) {
      throw new TavernError('INVALID_CREDENTIALS', 'Code did not match', 400);
    }
    const codes = generateBackupCodes(10);
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { totpBackupCodes: codes.map(hashBackupCode) },
    });
    reply.send(ok({ backupCodes: codes }));
  });
}
