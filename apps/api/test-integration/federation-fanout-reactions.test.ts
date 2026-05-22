/**
 * P3-9 — outbound fan-out on reaction.add and reaction.remove
 *
 * Coverage matrix:
 *   1. PUT /api/messages/:id/reactions/:emoji federates: federated server +
 *      remote member + author reacts → one enqueue per peer with eventType
 *      'reaction.add' and a payload that satisfies the shared schema.
 *   2. DELETE federates: same gating + payload for 'reaction.remove'.
 *   3. Reactions on a message whose `originInstanceId IS NOT NULL` (an
 *      inbound federated row) MUST NOT enqueue. Phase 3 has no relay —
 *      a reactor's home instance delivers directly to every peer.
 *   4. DM reactions stay out of the federation path entirely.
 *   5. force_off on the channel suppresses the fan-out, mirroring the
 *      message routes.
 *
 * The queue is a vi.fn() throughout — dispatch is covered by the federation-
 * outbox.test.ts suite from P3-5.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  reactionAddPayloadSchema,
  reactionRemovePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
  SHARED_DATA_KEY,
} from './setup.js';
import type { FederationOutboxJob } from '@tavern/federation';

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

interface Fixture {
  ownerId: string;
  serverId: string;
  channelId: string;
  authorId: string;
  authorUsername: string;
  peerAId: string;
}

async function createUser(opts: {
  remoteInstanceId?: string;
  username?: string;
}): Promise<{ id: string; username: string }> {
  const id = ulid();
  const username = opts.username ?? `u-${id.slice(-8).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username,
      usernameLower: username.toLowerCase(),
      displayName: username,
      email: `${id.toLowerCase()}@example.com`,
      emailLower: `${id.toLowerCase()}@example.com`,
      passwordHash: opts.remoteInstanceId ? null : 'x',
      ...(opts.remoteInstanceId
        ? {
            remoteUserId: `${username}@peer-${opts.remoteInstanceId.toLowerCase()}.example`,
            remoteInstanceId: opts.remoteInstanceId,
          }
        : {}),
    },
  });
  return { id, username };
}

async function makeFixture(opts?: { federationEnabled?: boolean }): Promise<Fixture> {
  const owner = await createUser({ username: `owner-${ulid().slice(-6).toLowerCase()}` });
  const author = await createUser({ username: `author-${ulid().slice(-6).toLowerCase()}` });
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();

  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: owner.id,
      name: 'Fed Tavern',
      federationEnabled: opts?.federationEnabled ?? true,
    },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: { id: channelId, serverId, type: 'text', name: 'general' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: owner.id } });
  await prisma.serverMember.create({ data: { serverId, userId: author.id } });

  // Peered remote instance + a remote member so fan-out has a target.
  const peerAId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerAId,
      host: `a-${peerAId.toLowerCase()}.example`,
      instanceKey: Buffer.alloc(32, 1),
      status: 'peered',
      capabilities: ['messages'],
    },
  });
  const remoteMember = await createUser({
    remoteInstanceId: peerAId,
    username: `rem-${ulid().slice(-6).toLowerCase()}`,
  });
  await prisma.serverMember.create({ data: { serverId, userId: remoteMember.id } });

  return {
    ownerId: owner.id,
    serverId,
    channelId,
    authorId: author.id,
    authorUsername: author.username,
    peerAId,
  };
}

async function mintTokenFor(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: {
      id: ulid(),
      userId,
      label: 'test',
      tokenHash: hash,
    },
  });
  return raw;
}

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: SHARED_DATA_KEY,
    PUBLIC_BASE_URL: 'https://self.example',
  } as NodeJS.ProcessEnv;
}

async function cleanDb(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.messageEdit.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.userMention.deleteMany({});
  await prisma.pinnedMessage.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  await prisma.federationKey.deleteMany({});
}

describe.skipIf(!dockerOk)('P3-9 — outbound fan-out (reaction routes)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('PUT federates reaction.add when channel is federated and remote member exists', async () => {
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.authorId);
      const create = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'reactable' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      // Drain the create enqueue so the assertion below only sees the
      // reaction enqueue.
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();
      captured.length = 0;

      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${createdId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('reaction.add');
      expect(job.messageId).toBe(createdId);
      const payload = reactionAddPayloadSchema.parse(job.payload);
      expect(payload.messageId).toBe(createdId);
      expect(payload.emoji).toBe('👍');
      expect(payload.actorRemoteUserId).toBe(`${fx.authorUsername}@self.example`);
    } finally {
      await app.close();
    }
  });

  it('DELETE federates reaction.remove when channel is federated and remote member exists', async () => {
    const fx = await makeFixture();

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const captured: FederationOutboxJob[] = [];
    const enqueue = vi.fn(async (job: FederationOutboxJob) => {
      captured.push(job);
    });
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.authorId);
      const create = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'reactable' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      // Add the reaction first so the DELETE has something to remove.
      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${createdId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();
      captured.length = 0;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${createdId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('reaction.remove');
      expect(job.messageId).toBe(createdId);
      const payload = reactionRemovePayloadSchema.parse(job.payload);
      expect(payload.messageId).toBe(createdId);
      expect(payload.emoji).toBe('👍');
      expect(payload.actorRemoteUserId).toBe(`${fx.authorUsername}@self.example`);
    } finally {
      await app.close();
    }
  });

  it('reaction on an inbound (originInstanceId-set) message does NOT federate', async () => {
    // Phase 3 has no relay. Reactions on a message that came from a peer
    // are NOT re-broadcast — each peer hears reactions directly from the
    // reactor's home instance. Even when the reactor is a LOCAL user, the
    // originInstanceId marker on the underlying message keeps the reaction
    // OUT of the outbox.
    const fx = await makeFixture();
    const messageId = ulid();
    await prisma.message.create({
      data: {
        id: messageId,
        serverId: fx.serverId,
        channelId: fx.channelId,
        authorId: fx.authorId,
        type: 'default',
        content: 'federated original',
        originInstanceId: fx.peerAId,
        signature: Buffer.alloc(64, 7),
      },
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.authorId);
      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      // And the remove path too — the gate is symmetric.
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      // No enqueue — the originInstanceId marker keeps both the add and
      // the remove out of the federation outbox path.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reaction on a DM message does NOT federate', async () => {
    // DMs are Phase 5; the reaction route still works locally, but it
    // never touches the federation outbox.
    const fx = await makeFixture();
    const partner = await createUser({ username: `dm-${ulid().slice(-6).toLowerCase()}` });

    // Build a DM channel between author and partner.
    const dmChannelId = ulid();
    await prisma.dmChannel.create({ data: { id: dmChannelId, kind: 'direct' } });
    await prisma.dmChannelMember.create({
      data: { dmChannelId, userId: fx.authorId },
    });
    await prisma.dmChannelMember.create({
      data: { dmChannelId, userId: partner.id },
    });
    const messageId = ulid();
    await prisma.message.create({
      data: {
        id: messageId,
        dmChannelId,
        authorId: fx.authorId,
        type: 'default',
        content: 'dm reactable',
      },
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.authorId);
      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${messageId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reaction on a force_off channel does NOT federate', async () => {
    const fx = await makeFixture();
    await prisma.channel.update({
      where: { id: fx.channelId },
      data: { federationMode: 'force_off' },
    });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.authorId);
      const create = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'force-off' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();

      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${createdId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${createdId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reaction on a server with federationEnabled=false does NOT federate', async () => {
    const fx = await makeFixture({ federationEnabled: false });

    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const enqueue = vi.fn(async () => undefined);
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: enqueue,
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintTokenFor(fx.authorId);
      const create = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'no-fed-server' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();

      const put = await app.inject({
        method: 'PUT',
        url: `/api/messages/${createdId}/reactions/${encodeURIComponent('👍')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
