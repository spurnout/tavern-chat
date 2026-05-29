/**
 * Integration coverage for `POST /api/invites/:code/join`.
 *
 * The route serves three behaviours that we lock in here:
 *   1. Instance-scoped invites — which are registration tickets, not join
 *      targets — return `{ serverId: null }` as a no-op for already-authed
 *      callers. `uses` is NOT incremented; no audit, no membership change.
 *   2. Server-scoped invites still redeem normally: 200 `{ serverId }`,
 *      `uses` increments, a `ServerMember` row is created.
 *   3. Server-scoped invites are idempotent for an existing member: the
 *      route returns the server id without double-incrementing `uses` or
 *      creating a second `ServerMember`.
 *
 * Federation is intentionally disabled so this file doesn't need the
 * federation key store, peering plumbing, or queue overrides for the
 * fan-out path — the join handler only touches the outbound queue when
 * the joined server has `federationEnabled=true` AND the instance has
 * federation on, neither of which is true here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
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
  await prisma.user.create({
    data: {
      id,
      username: slug,
      usernameLower: slug,
      displayName: slug,
      email: `${slug}@example.test`,
      emailLower: `${slug}@example.test`,
      passwordHash: 'x',
    },
  });
  return id;
}

async function makeServer(ownerId: string, name: string): Promise<string> {
  const serverId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name },
  });
  const everyoneId = ulid();
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
  // Owner gets a membership row so the gateway-side state is consistent —
  // the join route doesn't read it for the new joiner, but other code paths
  // assume owners are members too.
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return serverId;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: { id: ulid(), userId, label: 'test', tokenHash: hash },
  });
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

async function buildJoinApp() {
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

describe.skipIf(!dockerOk)('POST /api/invites/:code/join', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.invite.deleteMany({});
    await prisma.apiToken.deleteMany({});
    await prisma.serverBan.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('instance-scoped invite returns serverId:null and does not consume the invite', async () => {
    const userId = await makeUser('alice');
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'INSTANCE-CODE',
        scope: 'instance',
        serverId: null,
        createdById: null,
        maxUses: 5,
        uses: 0,
      },
    });

    const app = await buildJoinApp();
    try {
      const token = await mintToken(userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites/INSTANCE-CODE/join',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ serverId: string | null }>;
      expect(body.ok).toBe(true);
      expect(body.data.serverId).toBeNull();

      const after = await prisma.invite.findUnique({ where: { id: inviteId } });
      expect(after?.uses).toBe(0);

      // No membership was created — the caller didn't join anything.
      const memberships = await prisma.serverMember.count({ where: { userId } });
      expect(memberships).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('server-scoped invite redeems: 200 { serverId }, uses++, ServerMember created', async () => {
    const ownerId = await makeUser('owner');
    const joinerId = await makeUser('joiner');
    const serverId = await makeServer(ownerId, 'Test Tavern');
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'SERVER-CODE',
        scope: 'server',
        serverId,
        createdById: ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    const app = await buildJoinApp();
    try {
      const token = await mintToken(joinerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites/SERVER-CODE/join',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ serverId: string | null }>;
      expect(body.data.serverId).toBe(serverId);

      const after = await prisma.invite.findUnique({ where: { id: inviteId } });
      expect(after?.uses).toBe(1);

      const membership = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: joinerId } },
      });
      expect(membership).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('server-scoped invite is idempotent for an existing member — no second use, no duplicate row', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const serverId = await makeServer(ownerId, 'Test Tavern');
    // Caller is already a member of the server the invite points at.
    await prisma.serverMember.create({ data: { serverId, userId: memberId } });
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'SERVER-CODE',
        scope: 'server',
        serverId,
        createdById: ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    const app = await buildJoinApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites/SERVER-CODE/join',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ serverId: string | null }>;
      expect(body.data.serverId).toBe(serverId);

      // Existing-member fast path returns before the consume block, so the
      // counter must not move and no second ServerMember row appears.
      const after = await prisma.invite.findUnique({ where: { id: inviteId } });
      expect(after?.uses).toBe(0);

      const count = await prisma.serverMember.count({
        where: { serverId, userId: memberId },
      });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('a banned user cannot redeem a server invite — 403, no membership, no use consumed', async () => {
    const ownerId = await makeUser('owner');
    const bannedId = await makeUser('banned');
    const serverId = await makeServer(ownerId, 'Test Tavern');
    await prisma.serverBan.create({
      data: { serverId, userId: bannedId, bannedByUserId: ownerId, reason: 'spam' },
    });
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'SERVER-CODE',
        scope: 'server',
        serverId,
        createdById: ownerId,
        maxUses: null,
        uses: 0,
      },
    });

    const app = await buildJoinApp();
    try {
      const token = await mintToken(bannedId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites/SERVER-CODE/join',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);

      // The invite must not have been consumed, and no membership created.
      const after = await prisma.invite.findUnique({ where: { id: inviteId } });
      expect(after?.uses).toBe(0);
      const membership = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: bannedId } },
      });
      expect(membership).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('concurrent redeems of a maxUses:1 server invite admit exactly one joiner', async () => {
    const ownerId = await makeUser('owner');
    const serverId = await makeServer(ownerId, 'Test Tavern');
    const joinerIds = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) => makeUser(`joiner${i}`)),
    );
    const inviteId = ulid();
    await prisma.invite.create({
      data: {
        id: inviteId,
        code: 'ONE-SHOT',
        scope: 'server',
        serverId,
        createdById: ownerId,
        maxUses: 1,
        uses: 0,
      },
    });

    const app = await buildJoinApp();
    try {
      const tokens = await Promise.all(joinerIds.map((id) => mintToken(id)));
      const responses = await Promise.all(
        tokens.map((token) =>
          app.inject({
            method: 'POST',
            url: '/api/invites/ONE-SHOT/join',
            headers: { authorization: `Bearer ${token}` },
            payload: {},
          }),
        ),
      );

      const okCount = responses.filter((r) => r.statusCode === 200).length;
      const rejectedCount = responses.filter((r) => r.statusCode === 400).length;
      expect(okCount).toBe(1);
      expect(rejectedCount).toBe(joinerIds.length - 1);

      // The atomic predicate must have admitted exactly one joiner.
      const after = await prisma.invite.findUnique({ where: { id: inviteId } });
      expect(after?.uses).toBe(1);
      const joinerMemberships = await prisma.serverMember.count({
        where: { serverId, userId: { in: joinerIds } },
      });
      expect(joinerMemberships).toBe(1);
    } finally {
      await app.close();
    }
  });
});
