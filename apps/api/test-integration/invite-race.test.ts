/**
 * Integration test for the atomic invite consume (SEC-002). Two concurrent
 * registrations against a maxUses:1 invite must result in exactly one user
 * created — the previous read-then-update sequence allowed both to slip
 * through because the WHERE-clause check happened before the increment.
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

describe.skipIf(!dockerOk)('invite consume race (SEC-002)', () => {
  it('updateMany with uses<maxUses claims the slot atomically', async () => {
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'RACE-INVITE',
        scope: 'instance',
        maxUses: 1,
        uses: 0,
      },
    });

    // Fire 20 concurrent attempts that each try to consume the same slot.
    const attempts = Array.from({ length: 20 }, async () =>
      prisma.invite.updateMany({
        where: {
          id: inviteId,
          revokedAt: null,
          scope: 'instance',
          uses: { lt: 1 },
        },
        data: { uses: { increment: 1 } },
      }),
    );
    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r.count === 1);
    expect(successes).toHaveLength(1);

    const finalInvite = await prisma.invite.findUnique({ where: { id: inviteId } });
    expect(finalInvite?.uses).toBe(1);
  });

  it('expired invites cannot be consumed even with uses < maxUses', async () => {
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'EXPIRED-INVITE',
        scope: 'instance',
        maxUses: 5,
        uses: 0,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await prisma.invite.updateMany({
      where: {
        id: inviteId,
        revokedAt: null,
        scope: 'instance',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        uses: { lt: 5 },
      },
      data: { uses: { increment: 1 } },
    });
    expect(result.count).toBe(0);
  });

  it('server-scoped invites are rejected by the instance-only filter', async () => {
    const inviteId = ulid();
    const ownerId = ulid();
    const serverId = ulid();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'inv-owner',
        usernameLower: 'inv-owner',
        displayName: 'Owner',
        email: 'inv-owner@example.com',
        emailLower: 'inv-owner@example.com',
        passwordHash: 'x',
      },
    });
    await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'IS' } });
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'SERVER-SCOPE',
        scope: 'server',
        serverId,
        createdById: ownerId,
        maxUses: 10,
        uses: 0,
      },
    });

    const result = await prisma.invite.updateMany({
      where: {
        id: inviteId,
        revokedAt: null,
        scope: 'instance',
        uses: { lt: 10 },
      },
      data: { uses: { increment: 1 } },
    });
    expect(result.count).toBe(0);
  });
});
