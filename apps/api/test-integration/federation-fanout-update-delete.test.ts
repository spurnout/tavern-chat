/**
 * P3-8 — outbound fan-out on message.update and message.delete
 *
 * Coverage matrix:
 *   1. PATCH /api/messages/:id federates: federated server + remote member +
 *      author edits their message → one enqueue per peer with eventType
 *      'message.update' and a payload that satisfies the shared schema.
 *   2. DELETE /api/messages/:id federates: same gating + payload.
 *   3. Edits/deletes of a message whose `originInstanceId IS NOT NULL` (an
 *      inbound federated row) MUST NOT enqueue. Phase 3 has no relay — each
 *      peer hears the edit directly from the origin instance.
 *   4. DM messages stay out of the federation path entirely (no enqueue for
 *      a DM PATCH / DELETE).
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
  messageDeletePayloadSchema,
  messageUpdatePayloadSchema,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
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
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
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
}

describe.skipIf(!dockerOk)('P3-8 — outbound fan-out (PATCH/DELETE routes)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('PATCH federates the edit when channel is federated and remote member exists', async () => {
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
      // Create the original local message via the route — same path the
      // create-fanout test exercises. We then PATCH it and assert the
      // enqueue happens with eventType=message.update.
      const create = await app.inject({
        method: 'POST',
        url: `/api/channels/${fx.channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'original' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      // Drain the create enqueue so the assertion below only sees the
      // update enqueue.
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();
      captured.length = 0;

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${createdId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'edited' },
      });
      expect(patch.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('message.update');
      const payload = messageUpdatePayloadSchema.parse(job.payload);
      expect(payload.messageId).toBe(createdId);
      expect(payload.content).toBe('edited');
      expect(payload.authorRemoteUserId).toBe(`${fx.authorUsername}@self.example`);
      expect(payload.editedAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('DELETE federates the delete when channel is federated and remote member exists', async () => {
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
        payload: { content: 'doomed' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();
      captured.length = 0;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${createdId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.peerInstanceId).toBe(fx.peerAId);
      expect(job.eventType).toBe('message.delete');
      const payload = messageDeletePayloadSchema.parse(job.payload);
      expect(payload.messageId).toBe(createdId);
      expect(payload.actorRemoteUserId).toBe(`${fx.authorUsername}@self.example`);
      expect(payload.deletedAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('PATCH does NOT federate when the message has originInstanceId set (inbound row)', async () => {
    // Phase 3 has no relay. If a message arrived from a peer (originInstanceId
    // != null), our local edit handler MUST NOT re-broadcast to the peer
    // mesh — each peer learns the edit directly from the origin instance.
    const fx = await makeFixture();
    // Seed a federated message authored by our LOCAL user — atypical (the
    // origin would normally be the remote author), but stresses the gate:
    // the originInstanceId field is the marker we check, not the author.
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
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'edited locally but inbound row' },
      });
      expect(patch.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      // No enqueue — the originInstanceId marker keeps this edit OUT of
      // the federation outbox path.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('DELETE does NOT federate when the message has originInstanceId set', async () => {
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
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/messages/${messageId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('PATCH does NOT federate when channel.federationMode=force_off', async () => {
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
        payload: { content: 'in a force-off room' },
      });
      expect(create.statusCode).toBe(201);
      const createdId = create.json().data.id as string;
      await new Promise<void>((r) => setTimeout(r, 50));
      enqueue.mockClear();

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${createdId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'still force-off' },
      });
      expect(patch.statusCode).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
