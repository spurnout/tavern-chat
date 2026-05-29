/**
 * Integration coverage for the Wave-2 operator moderation actions in
 * `apps/api/src/routes/moderation-actions.ts`. Exercised end-to-end against a
 * real Postgres testcontainer via in-process `app.inject` so the permission
 * resolver and the concrete row mutations (`ServerMember.timeoutUntil`, member
 * deletion on kick, message soft-delete on bulk-delete, edit-history reads)
 * all run against actual rows.
 *
 * Routes covered:
 *   POST   /api/servers/:id/members/:userId/timeout   (TIMEOUT_MEMBERS)
 *   DELETE /api/servers/:id/members/:userId/timeout   (TIMEOUT_MEMBERS)
 *   POST   /api/servers/:id/members/:userId/kick      (KICK_MEMBERS)
 *   POST   /api/channels/:id/messages/bulk-delete      (MANAGE_MESSAGES)
 *   GET    /api/messages/:id/edits                     (author OR MANAGE_MESSAGES)
 *
 * Privileged actors are exercised two ways: the server owner (implicit
 * PERMISSION_ALL) and a plain member granted a single permission via a role
 * with a permissions bitset. Plain @everyone members are rejected with 403;
 * missing targets give 404; bad bodies / self-targeting give 400.
 *
 * Federation is off so the kick path never touches the outbound fan-out.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  Permission,
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
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

/**
 * Add `userId` as a member who also holds a dedicated role carrying exactly
 * `perm` (in addition to @everyone). Lets us assert a non-owner privileged
 * actor succeeds via a real role-permission grant.
 */
async function addMemberWithPermission(
  serverId: string,
  userId: string,
  perm: bigint,
): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
  const roleId = ulid();
  await prisma.role.create({
    data: {
      id: roleId,
      serverId,
      name: `mod-${roleId.slice(-6)}`,
      position: 5,
      permissions: new Prisma.Decimal(serializePermissions(perm)),
    },
  });
  await prisma.serverMemberRole.create({ data: { serverId, userId, roleId } });
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

function freshId(): string {
  return ulid();
}

function futureIso(msAhead = 60 * 60 * 1000): string {
  return new Date(Date.now() + msAhead).toISOString();
}

describe.skipIf(!dockerOk)('moderation-actions routes', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.messageEdit.deleteMany({});
    await prisma.auditLogEntry.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ---- POST /api/servers/:id/members/:userId/timeout ---------------------

  it('POST timeout — owner times out a member (200) and sets timeoutUntil', async () => {
    const ownerId = await makeUser('owner');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, targetId);

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const until = futureIso();
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { untilIso: until, reason: 'cooling off' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ userId: string; timeoutUntil: string }>;
      expect(body.data.userId).toBe(targetId);

      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member!.timeoutUntil).not.toBeNull();
      expect(member!.timeoutUntil!.toISOString()).toBe(new Date(until).toISOString());

      const audit = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'member.timeout', targetId },
      });
      expect(audit).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST timeout — a non-owner member granted TIMEOUT_MEMBERS via a role can time out (200)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMemberWithPermission(serverId, modId, Permission.TIMEOUT_MEMBERS);
    await addMember(serverId, targetId);

    const app = await buildTestApp();
    try {
      const modToken = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        headers: { authorization: `Bearer ${modToken}` },
        payload: { untilIso: futureIso() },
      });
      expect(res.statusCode).toBe(200);
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member!.timeoutUntil).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST timeout — plain member without TIMEOUT_MEMBERS is rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    await addMember(serverId, targetId);

    const app = await buildTestApp();
    try {
      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { untilIso: futureIso() },
      });
      expect(res.statusCode).toBe(403);
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member!.timeoutUntil).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST timeout — 404 when the target is not a member', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${freshId()}/timeout`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { untilIso: futureIso() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST timeout — 400 when timing out yourself', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${ownerId}/timeout`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { untilIso: futureIso() },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST timeout — 400 when untilIso is in the past', async () => {
    const ownerId = await makeUser('owner');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, targetId);

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { untilIso: new Date(Date.now() - 60_000).toISOString() },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST timeout — 401 without authentication', async () => {
    const ownerId = await makeUser('owner');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, targetId);

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        payload: { untilIso: futureIso() },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- DELETE /api/servers/:id/members/:userId/timeout -------------------

  it('DELETE timeout — owner clears an active timeout (200)', async () => {
    const ownerId = await makeUser('owner');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await prisma.serverMember.create({
      data: { serverId, userId: targetId, timeoutUntil: new Date(Date.now() + 3_600_000) },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ userId: string; timeoutUntil: null }>;
      expect(body.data.timeoutUntil).toBeNull();

      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member!.timeoutUntil).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE timeout — plain member without TIMEOUT_MEMBERS is rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    await prisma.serverMember.create({
      data: { serverId, userId: targetId, timeoutUntil: new Date(Date.now() + 3_600_000) },
    });

    const app = await buildTestApp();
    try {
      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}/members/${targetId}/timeout`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(res.statusCode).toBe(403);
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member!.timeoutUntil).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/servers/:id/members/:userId/kick ------------------------

  it('POST kick — owner kicks a member (200): ServerMember + role rows are removed', async () => {
    const ownerId = await makeUser('owner');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMemberWithPermission(serverId, targetId, Permission.ROLL_DICE);

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/kick`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { reason: 'rule breaking' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ userId: string }>;
      expect(body.data.userId).toBe(targetId);

      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member).toBeNull();
      // Role assignments cascaded away in the same transaction.
      const roleLinks = await prisma.serverMemberRole.findMany({
        where: { serverId, userId: targetId },
      });
      expect(roleLinks).toHaveLength(0);

      const audit = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'member.kick', targetId },
      });
      expect(audit).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST kick — plain member without KICK_MEMBERS is rejected (403); target remains', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const targetId = await makeUser('target');
    const { serverId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    await addMember(serverId, targetId);

    const app = await buildTestApp();
    try {
      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${targetId}/kick`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      });
      expect(member).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST kick — 404 when the target is not a member', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${freshId()}/kick`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST kick — 400 when kicking yourself', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${ownerId}/kick`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST kick — 403 when attempting to kick the server owner', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const { serverId } = await makeServerWithChannel(ownerId);
    // Grant the actor KICK_MEMBERS so we get past the permission gate and hit
    // the explicit owner-protection check.
    await addMemberWithPermission(serverId, modId, Permission.KICK_MEMBERS);

    const app = await buildTestApp();
    try {
      const modToken = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/members/${ownerId}/kick`,
        headers: { authorization: `Bearer ${modToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      const owner = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: ownerId } },
      });
      expect(owner).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/channels/:id/messages/bulk-delete -----------------------

  it('POST bulk-delete — owner soft-deletes the targeted messages (200)', async () => {
    const ownerId = await makeUser('owner');
    const authorId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, authorId);

    const idA = ulid();
    const idB = ulid();
    const keep = ulid();
    for (const [id, content] of [
      [idA, 'spam one'],
      [idB, 'spam two'],
      [keep, 'legit'],
    ] as const) {
      await prisma.message.create({
        data: { id, serverId, channelId, authorId, content },
      });
    }

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/bulk-delete`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { messageIds: [idA, idB] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ deleted: number }>;
      expect(body.data.deleted).toBe(2);

      const a = await prisma.message.findUnique({ where: { id: idA } });
      expect(a!.deletedAt).not.toBeNull();
      expect(a!.content).toBe('');
      // The non-targeted message is untouched.
      const kept = await prisma.message.findUnique({ where: { id: keep } });
      expect(kept!.deletedAt).toBeNull();
      expect(kept!.content).toBe('legit');

      const audit = await prisma.auditLogEntry.findFirst({
        where: { serverId, action: 'message.bulk_delete', targetId: channelId },
      });
      expect(audit).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST bulk-delete — returns deleted:0 when no targeted message matches the channel', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    void serverId;

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/bulk-delete`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { messageIds: [freshId()] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ deleted: number }>;
      expect(body.data.deleted).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST bulk-delete — plain member without MANAGE_MESSAGES is rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId: ownerId, content: 'keep me' },
    });

    const app = await buildTestApp();
    try {
      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/bulk-delete`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { messageIds: [msgId] },
      });
      expect(res.statusCode).toBe(403);
      const msg = await prisma.message.findUnique({ where: { id: msgId } });
      expect(msg!.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST bulk-delete — 404 for a non-existent channel', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${freshId()}/messages/bulk-delete`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { messageIds: [freshId()] },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST bulk-delete — 400 on an empty messageIds array', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages/bulk-delete`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { messageIds: [] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/messages/:id/edits ---------------------------------------

  it('GET message edits — the author can read their own edit history (200)', async () => {
    const ownerId = await makeUser('owner');
    const authorId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, authorId);

    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId, content: 'current' },
    });
    await prisma.messageEdit.create({
      data: { id: ulid(), messageId: msgId, content: 'original draft', editedBy: authorId },
    });

    const app = await buildTestApp();
    try {
      const authorToken = await mintToken(authorId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${msgId}/edits`,
        headers: { authorization: `Bearer ${authorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ content: string; editor: { id: string } }>>;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.content).toBe('original draft');
      expect(body.data[0]!.editor.id).toBe(authorId);
    } finally {
      await app.close();
    }
  });

  it('GET message edits — owner (MANAGE_MESSAGES) can read another author history (200)', async () => {
    const ownerId = await makeUser('owner');
    const authorId = await makeUser('author');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, authorId);

    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId, content: 'current' },
    });
    await prisma.messageEdit.create({
      data: { id: ulid(), messageId: msgId, content: 'v1', editedBy: authorId },
    });

    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${msgId}/edits`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('GET message edits — a non-author member without MANAGE_MESSAGES is rejected (403)', async () => {
    const ownerId = await makeUser('owner');
    const authorId = await makeUser('author');
    const snooperId = await makeUser('snooper');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, authorId);
    await addMember(serverId, snooperId);

    const msgId = ulid();
    await prisma.message.create({
      data: { id: msgId, serverId, channelId, authorId, content: 'current' },
    });
    await prisma.messageEdit.create({
      data: { id: ulid(), messageId: msgId, content: 'secret v1', editedBy: authorId },
    });

    const app = await buildTestApp();
    try {
      const snooperToken = await mintToken(snooperId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${msgId}/edits`,
        headers: { authorization: `Bearer ${snooperToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('secret v1');
    } finally {
      await app.close();
    }
  });

  it('GET message edits — 404 for a missing message', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${freshId()}/edits`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
