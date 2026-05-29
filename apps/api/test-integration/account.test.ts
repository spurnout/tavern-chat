/**
 * Integration coverage for the account-management surface in
 * `apps/api/src/routes/account.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * These endpoints are USER-scoped — every handler resolves the caller through
 * `app.requireUser` and only ever touches that user's own rows (settings,
 * login Sessions, UserDataExports, the User row itself). So the fixtures are
 * deliberately thin: a User + a `tvn_pat_*` API token. Where a handler reads
 * Session / UserDataExport rows we create them directly via Prisma so we can
 * pin a specific shape (revoked, ready, expired, …) without driving the async
 * worker job.
 *
 * Endpoints exercised:
 *   GET    /api/me/account              — read federation opt-outs
 *   PATCH  /api/me/account              — update opt-outs (+ validation)
 *   GET    /api/me/sessions             — list non-revoked login sessions
 *   DELETE /api/me/sessions/:id         — revoke one (own / 404 / 400)
 *   POST   /api/me/sessions/revoke-others — revoke all
 *   POST   /api/me/export               — queue export (+ inflight cooldown)
 *   GET    /api/me/exports              — list exports
 *   GET    /api/me/exports/:id/download — owner-only stream (404 / 400 gates)
 *   POST   /api/me/delete               — schedule deletion (admin/owner gates)
 *   POST   /api/me/delete/cancel        — clear the schedule
 *
 * Federation is off so no route touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';

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

async function makeUser(slug: string, opts: { isInstanceAdmin?: boolean } = {}): Promise<string> {
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
      isInstanceAdmin: opts.isInstanceAdmin ?? false,
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

/** Insert a login Session row directly (the account routes only read/revoke). */
async function makeSession(
  userId: string,
  overrides: Partial<{ deviceName: string; revokedAt: Date | null; expiresAt: Date }> = {},
): Promise<string> {
  const id = ulid();
  await prisma.session.create({
    data: {
      id,
      userId,
      refreshTokenHash: randomBytes(16).toString('hex'),
      deviceName: overrides.deviceName ?? 'Test Device',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: overrides.revokedAt ?? null,
    },
  });
  return id;
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

describe.skipIf(!dockerOk)('account routes (apps/api/src/routes/account.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.userDataExport.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- GET/PATCH /api/me/account --------------------------------------

  it('GET /api/me/account returns the default federation opt-ins', async () => {
    const userId = await makeUser('acct');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        acceptsFederatedDms: boolean;
        acceptsFederatedPresence: boolean;
      }>;
      // Schema defaults: both opt-ins are true for a fresh user.
      expect(body.data.acceptsFederatedDms).toBe(true);
      expect(body.data.acceptsFederatedPresence).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/account without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/account' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/me/account updates only the supplied fields and persists', async () => {
    const userId = await makeUser('acct');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
        payload: { acceptsFederatedDms: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        acceptsFederatedDms: boolean;
        acceptsFederatedPresence: boolean;
      }>;
      expect(body.data.acceptsFederatedDms).toBe(false);
      // The field we didn't send is untouched (still the default true).
      expect(body.data.acceptsFederatedPresence).toBe(true);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { acceptsFederatedDms: true, acceptsFederatedPresence: true },
      });
      expect(row.acceptsFederatedDms).toBe(false);
      expect(row.acceptsFederatedPresence).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/me/account rejects a non-boolean value with 400', async () => {
    const userId = await makeUser('acct');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/account',
        headers: { authorization: `Bearer ${token}` },
        payload: { acceptsFederatedDms: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      // Nothing should have changed.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { acceptsFederatedDms: true },
      });
      expect(row.acceptsFederatedDms).toBe(true);
    } finally {
      await app.close();
    }
  });

  // ---- Sessions: list / revoke-one / revoke-others --------------------

  it('GET /api/me/sessions lists only the caller\'s non-revoked sessions', async () => {
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const liveA = await makeSession(userId, { deviceName: 'Laptop' });
      const liveB = await makeSession(userId, { deviceName: 'Phone' });
      await makeSession(userId, { deviceName: 'Old', revokedAt: new Date() }); // revoked → excluded
      await makeSession(otherId, { deviceName: 'Foreign' }); // other user → excluded

      const res = await app.inject({
        method: 'GET',
        url: '/api/me/sessions',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; deviceName: string | null }>>;
      const ids = body.data.map((s) => s.id).sort();
      expect(ids).toEqual([liveA, liveB].sort());
      // ISO-string serialization is applied to the date fields.
      const first = body.data[0] as unknown as { createdAt: string; expiresAt: string };
      expect(typeof first.createdAt).toBe('string');
      expect(typeof first.expiresAt).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/sessions without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/sessions' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/sessions/:id revokes the caller\'s own session', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const sessionId = await makeSession(userId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/sessions/${sessionId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(sessionId);

      const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.revokedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/sessions/:id for another user\'s session is 404 (and leaves it intact)', async () => {
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const foreignSession = await makeSession(otherId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/sessions/${foreignSession}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);

      const row = await prisma.session.findUniqueOrThrow({ where: { id: foreignSession } });
      expect(row.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/sessions/:id for an unknown id is 404', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/me/sessions/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/me/sessions/:id with a malformed id is 400', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me/sessions/not-a-ulid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/sessions/revoke-others revokes every live session for the caller', async () => {
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      await makeSession(userId, { deviceName: 'A' });
      await makeSession(userId, { deviceName: 'B' });
      const foreign = await makeSession(otherId, { deviceName: 'Foreign' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/sessions/revoke-others',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);

      const liveForCaller = await prisma.session.count({
        where: { userId, revokedAt: null },
      });
      expect(liveForCaller).toBe(0);
      // The other user's session is untouched.
      const foreignRow = await prisma.session.findUniqueOrThrow({ where: { id: foreign } });
      expect(foreignRow.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ---- Data export: queue / cooldown / list / download ----------------

  it('POST /api/me/export queues a pending export (202) and writes the row', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/export',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as OkBody<{ exportId: string; status: string }>;
      expect(body.data.exportId).toBeTruthy();

      const row = await prisma.userDataExport.findUniqueOrThrow({
        where: { id: body.data.exportId },
      });
      expect(row.userId).toBe(userId);
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/export returns the inflight export instead of queuing a duplicate', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      // Seed an already-running export so the cooldown branch fires.
      const inflightId = ulid();
      await prisma.userDataExport.create({
        data: {
          id: inflightId,
          userId,
          status: 'running',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/export',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as OkBody<{ exportId: string; status: string }>;
      expect(body.data.exportId).toBe(inflightId);
      expect(body.data.status).toBe('running');

      // No second row was created.
      const count = await prisma.userDataExport.count({ where: { userId } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/exports lists the caller\'s exports (newest first)', async () => {
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const older = ulid();
      const newer = ulid();
      await prisma.userDataExport.create({
        data: {
          id: older,
          userId,
          status: 'ready',
          requestedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await prisma.userDataExport.create({
        data: {
          id: newer,
          userId,
          status: 'pending',
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      // Belongs to someone else — must not appear.
      await prisma.userDataExport.create({
        data: {
          id: ulid(),
          userId: otherId,
          status: 'ready',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/me/exports',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; status: string }>>;
      expect(body.data.map((r) => r.id)).toEqual([newer, older]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/exports/:id/download is 404 for another user\'s export', async () => {
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const foreignExport = ulid();
      await prisma.userDataExport.create({
        data: {
          id: foreignExport,
          userId: otherId,
          status: 'ready',
          storageBucket: 'main',
          storageKey: 'exports/x/y.zip',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/me/exports/${foreignExport}/download`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/exports/:id/download is 400 when the export is not ready yet', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const pending = ulid();
      await prisma.userDataExport.create({
        data: {
          id: pending,
          userId,
          status: 'pending',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/me/exports/${pending}/download`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /api/me/exports/:id/download is 400 when a ready export has expired', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const expired = ulid();
      await prisma.userDataExport.create({
        data: {
          id: expired,
          userId,
          status: 'ready',
          storageBucket: 'main',
          storageKey: 'exports/x/expired.zip',
          sizeBytes: 10,
          expiresAt: new Date(Date.now() - 1000), // already in the past
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/me/exports/${expired}/download`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- Account deletion: schedule / gates / cancel --------------------

  it('POST /api/me/delete schedules deletion with a 7-day grace window', async () => {
    const userId = await makeUser('deleter');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/delete',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ scheduledDeleteAt: string; graceDays: number }>;
      expect(body.data.graceDays).toBe(7);
      expect(typeof body.data.scheduledDeleteAt).toBe('string');

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { scheduledDeleteAt: true },
      });
      expect(row.scheduledDeleteAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/delete is 403 for an instance admin', async () => {
    const adminId = await makeUser('admin', { isInstanceAdmin: true });
    const app = await buildTestApp();
    try {
      const token = await mintToken(adminId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/delete',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: adminId },
        select: { scheduledDeleteAt: true },
      });
      expect(row.scheduledDeleteAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/delete is 400 when the caller still owns a tavern', async () => {
    const userId = await makeUser('owner');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      await prisma.server.create({
        data: { id: ulid(), ownerUserId: userId, name: 'Owned Tavern' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/delete',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { scheduledDeleteAt: true },
      });
      expect(row.scheduledDeleteAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/delete/cancel clears a pending deletion schedule', async () => {
    const userId = await makeUser('deleter');
    const app = await buildTestApp();
    try {
      const token = await mintToken(userId);
      await prisma.user.update({
        where: { id: userId },
        data: { scheduledDeleteAt: new Date(Date.now() + 86_400_000) },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/delete/cancel',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ ok: boolean }>;
      expect(body.data.ok).toBe(true);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { scheduledDeleteAt: true },
      });
      expect(row.scheduledDeleteAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/me/delete/cancel without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/me/delete/cancel' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
