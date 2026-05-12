/**
 * Integration test for the audit-retention sweep that runs in the worker
 * (DB-009). The worker code does the exact same `deleteMany` we exercise
 * here; we test against a real DB so the operation's transactional
 * behaviour and index usage are observable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
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

describe.skipIf(!dockerOk)('audit retention sweep (DB-009)', () => {
  it('deletes entries older than the cutoff and preserves newer ones', async () => {
    const oldId = ulid();
    const newId = ulid();
    const now = Date.now();
    await prisma.auditLogEntry.create({
      data: {
        id: oldId,
        action: 'old.event',
        createdAt: new Date(now - 95 * 86_400_000),
      },
    });
    await prisma.auditLogEntry.create({
      data: {
        id: newId,
        action: 'recent.event',
        createdAt: new Date(now - 30 * 86_400_000),
      },
    });

    const cutoff = new Date(now - 90 * 86_400_000);
    const result = await prisma.auditLogEntry.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    expect(result.count).toBe(1);

    expect(await prisma.auditLogEntry.findUnique({ where: { id: oldId } })).toBeNull();
    expect(await prisma.auditLogEntry.findUnique({ where: { id: newId } })).not.toBeNull();
  });
});

describe.skipIf(!dockerOk)('message nonce cleanup (DB-010)', () => {
  it('nulls nonces older than the cutoff', async () => {
    const ownerId = ulid();
    const serverId = ulid();
    const channelId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'nc-owner',
        usernameLower: 'nc-owner',
        displayName: 'Owner',
        email: 'nc-owner@example.com',
        emailLower: 'nc-owner@example.com',
        passwordHash: 'x',
      },
    });
    await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'NC' } });
    await prisma.channel.create({
      data: { id: channelId, serverId, type: 'text', name: 'general' },
    });

    const now = Date.now();
    const oldMsgId = ulid();
    const newMsgId = ulid();
    await prisma.message.create({
      data: {
        id: oldMsgId,
        serverId,
        channelId,
        authorId: ownerId,
        content: 'old',
        nonce: 'old-nonce-aaaa',
        createdAt: new Date(now - 36 * 3_600_000),
      },
    });
    await prisma.message.create({
      data: {
        id: newMsgId,
        serverId,
        channelId,
        authorId: ownerId,
        content: 'new',
        nonce: 'new-nonce-bbbb',
        createdAt: new Date(now - 1 * 3_600_000),
      },
    });

    const cutoff = new Date(now - 24 * 3_600_000);
    const result = await prisma.message.updateMany({
      where: { nonce: { not: null }, createdAt: { lt: cutoff } },
      data: { nonce: null },
    });
    expect(result.count).toBe(1);

    const oldAfter = await prisma.message.findUnique({ where: { id: oldMsgId } });
    expect(oldAfter?.nonce).toBeNull();
    const newAfter = await prisma.message.findUnique({ where: { id: newMsgId } });
    expect(newAfter?.nonce).toBe('new-nonce-bbbb');
  });
});
