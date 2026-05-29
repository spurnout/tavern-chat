/**
 * Integration coverage for the server-scoped moderation routes in
 * `apps/api/src/routes/moderation.ts`. Exercised end-to-end against a real
 * Postgres testcontainer via in-process `app.inject` so the permission
 * resolver, the audit writes, and the concrete report-resolution side effects
 * (soft-delete + `safetyState`, `postingLockedUntil`/`uploadsLockedUntil`) all
 * run against actual rows.
 *
 * Routes covered:
 *   POST   /api/reports                              (any authed user)
 *   GET    /api/servers/:serverId/moderation/queue   (VIEW_MODERATION_QUEUE)
 *   GET    /api/servers/:serverId/moderation/stats   (VIEW_MODERATION_QUEUE)
 *   POST   /api/reports/:id/resolve                  (MANAGE_REPORT_WORKFLOW)
 *   GET    /api/servers/:serverId/safety-policy      (any member)
 *   PATCH  /api/servers/:serverId/safety-policy      (MANAGE_SERVER_SAFETY_POLICY)
 *   GET    /api/servers/:serverId/audit-log          (VIEW_AUDIT_LOG)
 *
 * For each: a privileged actor (the server owner, who holds every permission)
 * succeeds; a plain @everyone member is rejected with 403; missing rows give
 * 404; malformed bodies give 400; and an unauthenticated request gives 401.
 *
 * Federation is off so the routes never touch the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, serializePermissions, ulid } from '@tavern/shared';
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

/**
 * Server owned by `ownerId` with an @everyone role (default civic perms) and a
 * text channel. The owner bypasses every permission check (PERMISSION_ALL); a
 * plain member added via `addMember` only holds @everyone.
 */
async function makeServerWithChannel(
  ownerId: string,
): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Mod Tavern' } });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'general' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, channelId, everyoneId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
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

/** A syntactically valid ULID that does not exist in the DB. */
function freshId(): string {
  return ulid();
}

describe.skipIf(!dockerOk)('moderation routes (server-scoped)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.moderationAction.deleteMany({});
    await prisma.report.deleteMany({});
    await prisma.auditLogEntry.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.safetyPolicy.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- POST /api/reports -------------------------------------------------

  it('POST /api/reports — any authed user can file a report (201) and a row is written', async () => {
    const aliceId = await makeUser('alice');
    const { serverId } = await makeServerWithChannel(aliceId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const targetId = freshId();
      const res = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          serverId,
          targetType: 'message',
          targetId,
          category: 'spam_or_raid',
          notes: 'looks like a raid',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string; reporterId: string; status: string }>;
      expect(body.data.reporterId).toBe(aliceId);
      expect(body.data.status).toBe('open');

      const row = await prisma.report.findUnique({ where: { id: body.data.id } });
      expect(row).not.toBeNull();
      expect(row!.targetId).toBe(targetId);
      expect(row!.category).toBe('spam_or_raid');

      // A `report.created` audit entry is recorded for the server.
      const audit = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'report.created', targetId: body.data.id },
      });
      expect(audit).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST /api/reports — rejects an unauthenticated caller (401)', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/reports',
        payload: { targetType: 'profile', targetId: freshId(), category: 'spam_or_raid' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/reports — rejects an invalid category (400)', async () => {
    const aliceId = await makeUser('alice');
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'message', targetId: freshId(), category: 'not_a_real_category' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/servers/:serverId/moderation/queue -----------------------

  it('GET moderation/queue — owner sees enriched reports (200); plain member rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const reporterId = await makeUser('reporter');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, reporterId);

    // A message target so the queue enrichment path (author/preview) runs.
    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId: reporterId, content: 'reported text' },
    });
    await prisma.report.create({
      data: {
        id: ulid(),
        serverId,
        reporterId,
        targetType: 'message',
        targetId: msgId,
        category: 'spam_or_raid',
        status: 'open',
      },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const ownerRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/moderation/queue`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(ownerRes.statusCode).toBe(200);
      const body = ownerRes.json() as OkBody<
        Array<{ id: string; targetPreview: string | null; events: unknown[] }>
      >;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.targetPreview).toBe('reported text');
      // Timeline is anchored with the report.opened event.
      expect(body.data[0]!.events.length).toBeGreaterThanOrEqual(1);

      // A plain member (only @everyone, lacks VIEW_MODERATION_QUEUE) → 403.
      const memberToken = await mintToken(reporterId);
      const memberRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/moderation/queue`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(memberRes.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/servers/:serverId/moderation/stats -----------------------

  it('GET moderation/stats — owner gets counts (200); non-member rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServerWithChannel(ownerId);
    await prisma.report.create({
      data: {
        id: ulid(),
        serverId,
        reporterId: ownerId,
        targetType: 'profile',
        targetId: freshId(),
        category: 'spam_or_raid',
        status: 'in_review',
      },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/moderation/stats`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ openReports: number; inReview: number; newToday: number }>;
      expect(body.data.openReports).toBe(1);
      expect(body.data.inReview).toBe(1);
      expect(body.data.newToday).toBe(1);

      // A user who is not a member of the server has no permissions → 403.
      const outsiderToken = await mintToken(outsiderId);
      const denied = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/moderation/stats`,
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/reports/:id/resolve -------------------------------------

  it('POST /api/reports/:id/resolve — owner resolves with block action: message soft-deleted + quarantined state', async () => {
    const ownerId = await makeUser('owner');
    const offenderId = await makeUser('offender');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, offenderId);

    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId: offenderId, content: 'bad content' },
    });
    const reportId = ulid();
    await prisma.report.create({
      data: {
        id: reportId,
        serverId,
        reporterId: ownerId,
        targetType: 'message',
        targetId: msgId,
        category: 'spam_or_raid',
        status: 'open',
      },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/reports/${reportId}/resolve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { status: 'resolved', action: 'block', notes: 'removed' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ status: string; resolvedById: string }>;
      expect(body.data.status).toBe('resolved');
      expect(body.data.resolvedById).toBe(ownerId);

      // The reported message is soft-deleted with its content cleared and a
      // blocked safety state.
      const msg = await prisma.message.findUnique({ where: { id: msgId } });
      expect(msg!.deletedAt).not.toBeNull();
      expect(msg!.content).toBe('');
      expect(msg!.safetyState).toBe('blocked');

      // A ModerationAction row is recorded.
      const action = await prisma.moderationAction.findFirst({ where: { reportId } });
      expect(action).not.toBeNull();
      expect(action!.action).toBe('block');
    } finally {
      await app.close();
    }
  });

  it('POST /api/reports/:id/resolve — lock_account locks the offender posting + uploads', async () => {
    const ownerId = await makeUser('owner');
    const offenderId = await makeUser('offender');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, offenderId);

    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId: offenderId, content: 'bad' },
    });
    const reportId = ulid();
    await prisma.report.create({
      data: {
        id: reportId,
        serverId,
        reporterId: ownerId,
        targetType: 'message',
        targetId: msgId,
        category: 'policy_evasion',
        status: 'open',
      },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/reports/${reportId}/resolve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { status: 'escalated', action: 'lock_account' },
      });
      expect(res.statusCode).toBe(200);

      const offender = await prisma.user.findUnique({ where: { id: offenderId } });
      expect(offender!.postingLockedUntil).not.toBeNull();
      expect(offender!.uploadsLockedUntil).not.toBeNull();
      expect(offender!.postingLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });

  it('POST /api/reports/:id/resolve — 404 for a non-existent report', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/reports/${freshId()}/resolve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { status: 'resolved' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/reports/:id/resolve — plain member without MANAGE_REPORT_WORKFLOW is rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);

    const reportId = ulid();
    await prisma.report.create({
      data: {
        id: reportId,
        serverId,
        reporterId: ownerId,
        targetType: 'profile',
        targetId: freshId(),
        category: 'spam_or_raid',
        status: 'open',
      },
    });

    const app = await buildTestApp();
    try {
      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/reports/${reportId}/resolve`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { status: 'resolved' },
      });
      expect(res.statusCode).toBe(403);

      // Report is untouched.
      const row = await prisma.report.findUnique({ where: { id: reportId } });
      expect(row!.status).toBe('open');
    } finally {
      await app.close();
    }
  });

  it('POST /api/reports/:id/resolve — invalid status (400)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const reportId = ulid();
    await prisma.report.create({
      data: {
        id: reportId,
        serverId,
        reporterId: ownerId,
        targetType: 'profile',
        targetId: freshId(),
        category: 'spam_or_raid',
        status: 'open',
      },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/reports/${reportId}/resolve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { status: 'open' }, // not an allowed resolve status
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/servers/:serverId/safety-policy --------------------------

  it('GET safety-policy — member can read an existing policy (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    await prisma.safetyPolicy.create({ data: { serverId, sfwOnly: true } });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/safety-policy`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ serverId: string; sfwOnly: boolean }>;
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.sfwOnly).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET safety-policy — 404 when the server has no policy row', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/safety-policy`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET safety-policy — 404 for a non-member (existence is not leaked)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServerWithChannel(ownerId);
    await prisma.safetyPolicy.create({ data: { serverId } });

    const app = await buildTestApp();
    try {
      const outsiderToken = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/safety-policy`,
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ---- PATCH /api/servers/:serverId/safety-policy ------------------------

  it('PATCH safety-policy — owner updates fields (200) and writes an audit entry', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    await prisma.safetyPolicy.create({ data: { serverId } });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}/safety-policy`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { sfwOnly: true, profanityFilter: 'strict' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ sfwOnly: boolean; profanityFilter: string }>;
      expect(body.data.sfwOnly).toBe(true);
      expect(body.data.profanityFilter).toBe('strict');

      const row = await prisma.safetyPolicy.findUnique({ where: { serverId } });
      expect(row!.sfwOnly).toBe(true);
      expect(row!.profanityFilter).toBe('strict');

      const audit = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'safety_policy.updated' },
      });
      expect(audit).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('PATCH safety-policy — plain member without MANAGE_SERVER_SAFETY_POLICY is rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    await prisma.safetyPolicy.create({ data: { serverId } });

    const app = await buildTestApp();
    try {
      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}/safety-policy`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { sfwOnly: true },
      });
      expect(res.statusCode).toBe(403);

      const row = await prisma.safetyPolicy.findUnique({ where: { serverId } });
      expect(row!.sfwOnly).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('PATCH safety-policy — invalid profanityFilter value (400)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    await prisma.safetyPolicy.create({ data: { serverId } });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}/safety-policy`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { profanityFilter: 'nuclear' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/servers/:serverId/audit-log ------------------------------

  it('GET audit-log — owner reads entries with hydrated actor names (200); plain member rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);

    await prisma.auditLogEntry.create({
      data: {
        id: ulid(),
        serverId,
        actorId: ownerId,
        action: 'server.updated',
        targetType: 'server',
        targetId: serverId,
      },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/audit-log`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ action: string; actorId: string | null }>>;
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const entry = body.data.find((e) => e.action === 'server.updated');
      expect(entry).toBeDefined();
      expect(entry!.actorId).toBe(ownerId);

      // VIEW_AUDIT_LOG is not in the @everyone default set → plain member 403.
      const memberToken = await mintToken(memberId);
      const denied = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/audit-log`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET audit-log — 401 without authentication', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/audit-log`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
