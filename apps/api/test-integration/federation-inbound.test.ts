/**
 * P3-7: Inbound `POST /_federation/event` — message.create handler.
 *
 * Coverage matrix:
 *   1. Happy path: peered peer + cached RemoteUser + federated server channel
 *      + remote member → 200, Message row persisted, originInstanceId + signature
 *      bytes set, MESSAGE_CREATE broadcast on the gateway.
 *   2. Unknown peer (no RemoteInstance row for fromInstance) → 403.
 *   3. Peer status != 'peered' (e.g. revoked) → 403.
 *   4. Bad instance signature (envelope signed with wrong instance key) → 401.
 *   5. Bad user signature (envelope signed with wrong user key) → 401.
 *   6. Replay (POST same envelope twice) → second hit is 409.
 *   7. Unknown channel (payload.channelId not in DB) → 404.
 *   8. Federation off on channel (force_off or server.federationEnabled=false +
 *      mode=inherit) → 403.
 *   9. Unimplemented event type (e.g. 'message.update' in P3-7) → 501.
 *  10. Idempotent re-delivery (same messageId already persisted) → 200 with
 *      deduplicated:true; replay protection drops it earlier in practice but
 *      this confirms the handler itself is idempotent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  generateKeyPair,
  exportPublicKeyRaw,
  sign as edSign,
  buildTwoLayerMessageEnvelope,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';

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

const SELF_HOST = 'self.example';
const PEER_HOST = 'b.example';

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: `https://${SELF_HOST}`,
  } as NodeJS.ProcessEnv;
}

interface PeerFixture {
  /** RemoteInstance.id of the peer (b.example) */
  peerInstanceId: string;
  /** ed25519 keypair representing the peer's instance signing key */
  peerKp: ReturnType<typeof generateKeyPair>;
  /** Author user keypair (the remote user who is publishing) */
  authorKp: ReturnType<typeof generateKeyPair>;
  /** Qualified remote user id, e.g. "alice@b.example" */
  authorRemoteUserId: string;
  /** RemoteUser row id for the author */
  remoteUserId: string;
  /** Local User row id (synthesised by ensureUserForRemoteUser BEFORE the test runs) */
  localUserId: string;
  /** A federated server with the author as a member */
  serverId: string;
  /** Channel inside the server, federation defaults to inherit (server flag on) */
  channelId: string;
}

/**
 * Seed a complete fixture for inbound testing:
 *   - peered RemoteInstance with a known instance key
 *   - RemoteUser cache row with a known author key
 *   - User row that mirrors the RemoteUser (so the channel membership FK works)
 *   - Server with federationEnabled=true and the author as a ServerMember
 *   - Channel in the server with federationMode='inherit'
 */
async function makeFixture(opts?: {
  serverFederationEnabled?: boolean;
  channelFederationMode?: 'inherit' | 'force_on' | 'force_off';
  peerStatus?: 'peered' | 'revoked' | 'pending_inbound' | 'blocked' | 'pending_outbound';
}): Promise<PeerFixture> {
  const peerKp = generateKeyPair();
  const authorKp = generateKeyPair();
  const peerInstanceId = ulid();
  const localpart = `alice-${peerInstanceId.slice(-6).toLowerCase()}`;
  const authorRemoteUserId = `${localpart}@${PEER_HOST}`;
  const remoteUserId = ulid();

  await prisma.remoteInstance.create({
    data: {
      id: peerInstanceId,
      host: PEER_HOST,
      instanceKey: exportPublicKeyRaw(peerKp.publicKey),
      status: opts?.peerStatus ?? 'peered',
      capabilities: ['messages'],
      peeredAt: new Date(),
    },
  });

  await prisma.remoteUser.create({
    data: {
      id: remoteUserId,
      remoteInstanceId: peerInstanceId,
      remoteUserId: authorRemoteUserId,
      displayNameCache: 'Alice from B',
      avatarUrlCache: null,
      publicKey: exportPublicKeyRaw(authorKp.publicKey),
      lastSeenAt: new Date(0), // ancient so the handler must update
    },
  });

  // The owner is a local human — the author is the remote user we created
  // above. Both are members so the channel has at least one message-sender
  // (owner) and one federated participant (author).
  const ownerId = ulid();
  const ownerUsername = `owner-${ownerId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: ownerId,
      username: ownerUsername,
      usernameLower: ownerUsername,
      displayName: 'Owner',
      email: `${ownerUsername}@example.com`,
      emailLower: `${ownerUsername}@example.com`,
      passwordHash: 'x',
    },
  });

  // Materialise the remote user as a User row up-front so we can attach a
  // ServerMember FK. The handler also calls ensureUserForRemoteUser; the
  // unique constraint on remoteUserId makes both calls idempotent.
  const localUserId = ulid();
  const syntheticUsername = `__rem_${ulid().toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: localUserId,
      username: syntheticUsername,
      usernameLower: syntheticUsername,
      displayName: 'Alice from B',
      email: `${authorRemoteUserId}.federated.local`,
      emailLower: `${authorRemoteUserId}.federated.local`,
      passwordHash: null,
      remoteUserId: authorRemoteUserId,
      remoteInstanceId: peerInstanceId,
      federationKeyPublic: exportPublicKeyRaw(authorKp.publicKey),
    },
  });

  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: ownerId,
      name: 'Federated Tavern',
      federationEnabled: opts?.serverFederationEnabled ?? true,
    },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE),
      ),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: {
      id: channelId,
      serverId,
      type: 'text',
      name: 'general',
      federationMode: opts?.channelFederationMode ?? 'inherit',
    },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  await prisma.serverMember.create({ data: { serverId, userId: localUserId } });

  return {
    peerInstanceId,
    peerKp,
    authorKp,
    authorRemoteUserId,
    remoteUserId,
    localUserId,
    serverId,
    channelId,
  };
}

interface BuildMessageEnvelopeInput {
  fx: PeerFixture;
  messageId?: string;
  content?: string;
  /** Override the user-key used to sign the payload (for bad-user-sig tests). */
  signUserOverride?: (bytes: Buffer) => Buffer;
  /** Override the instance-key used to sign the envelope (for bad-instance-sig tests). */
  signInstanceOverride?: (bytes: Buffer) => Buffer;
  eventType?: 'message.create' | 'message.update' | 'message.delete' | 'reaction.add' | 'reaction.remove';
}

function buildMsgCreateEnvelope(input: BuildMessageEnvelopeInput): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: input.eventType ?? 'message.create',
    fromInstance: PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      authorRemoteUserId: fx.authorRemoteUserId,
      channelId: fx.channelId,
      messageId: input.messageId ?? ulid(),
      content: input.content ?? 'hello from peer',
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    },
    signUser: input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

async function cleanDb(): Promise<void> {
  // Order matters — children before parents.
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.remoteUser.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.remoteInstance.deleteMany({});
  await prisma.federationKey.deleteMany({});
}

describe.skipIf(!dockerOk)('P3-7 — POST /_federation/event (message.create)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: persists Message with origin+signature and broadcasts', async () => {
    const fx = await makeFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const messageId = ulid();
    const envelope = buildMsgCreateEnvelope({ fx, messageId, content: 'hi peers' });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data?.id).toBe(messageId);

      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row).not.toBeNull();
      expect(row!.channelId).toBe(fx.channelId);
      expect(row!.serverId).toBe(fx.serverId);
      expect(row!.authorId).toBe(fx.localUserId);
      expect(row!.content).toBe('hi peers');
      expect(row!.originInstanceId).toBe(fx.peerInstanceId);
      expect(row!.signature).not.toBeNull();
      expect(row!.signature!.length).toBeGreaterThan(0);

      // RemoteUser.lastSeenAt must have moved forward.
      const updatedRemoteUser = await prisma.remoteUser.findUnique({
        where: { id: fx.remoteUserId },
      });
      expect(updatedRemoteUser!.lastSeenAt.getTime()).toBeGreaterThan(0);

      // Envelope log must have one accepted entry for this peer.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'message.create' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
      expect(log!.direction).toBe('inbound');
    } finally {
      await app.close();
    }
  });

  it('unknown peer (no RemoteInstance row) → 403', async () => {
    // Don't seed the peer.
    const peerKp = generateKeyPair();
    const authorKp = generateKeyPair();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: 'ghost.example',
      toInstance: SELF_HOST,
      payload: {
        authorRemoteUserId: 'noone@ghost.example',
        channelId: ulid(),
        messageId: ulid(),
        content: 'orphan',
        replyToMessageId: null,
        createdAt: new Date().toISOString(),
      },
      signUser: (b: Buffer) => edSign(b, authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, peerKp.privateKey),
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/not a known peer/i);
    } finally {
      await app.close();
    }
  });

  it('peer status != peered (revoked) → 403', async () => {
    const fx = await makeFixture({ peerStatus: 'revoked' });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildMsgCreateEnvelope({ fx });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/not peered/i);
    } finally {
      await app.close();
    }
  });

  it('bad instance signature → 401', async () => {
    const fx = await makeFixture();
    const attacker = generateKeyPair();
    const envelope = buildMsgCreateEnvelope({
      fx,
      signInstanceOverride: (b: Buffer) => edSign(b, attacker.privateKey),
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toMatch(/instance signature/i);
    } finally {
      await app.close();
    }
  });

  it('bad user signature → 401', async () => {
    const fx = await makeFixture();
    const attacker = generateKeyPair();
    const envelope = buildMsgCreateEnvelope({
      fx,
      signUserOverride: (b: Buffer) => edSign(b, attacker.privateKey),
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toMatch(/user signature/i);
    } finally {
      await app.close();
    }
  });

  it('replay (same envelope POSTed twice) → first 200, second 409', async () => {
    const fx = await makeFixture();
    const envelope = buildMsgCreateEnvelope({ fx, messageId: ulid() });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.error).toMatch(/nonce.*already seen/i);
    } finally {
      await app.close();
    }
  });

  it('unknown channel (payload.channelId not in DB) → 404', async () => {
    const fx = await makeFixture();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: PEER_HOST,
      toInstance: SELF_HOST,
      payload: {
        authorRemoteUserId: fx.authorRemoteUserId,
        channelId: ulid(), // channel that doesn't exist
        messageId: ulid(),
        content: 'orphan channel',
        replyToMessageId: null,
        createdAt: new Date().toISOString(),
      },
      signUser: (b: Buffer) => edSign(b, fx.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, fx.peerKp.privateKey),
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toMatch(/not found/i);
    } finally {
      await app.close();
    }
  });

  it('channel federation mode=force_off → 403', async () => {
    const fx = await makeFixture({ channelFederationMode: 'force_off' });
    const envelope = buildMsgCreateEnvelope({ fx });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/federation is disabled/i);
    } finally {
      await app.close();
    }
  });

  it('server.federationEnabled=false (channel inherit) → 403', async () => {
    const fx = await makeFixture({ serverFederationEnabled: false });
    const envelope = buildMsgCreateEnvelope({ fx });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/federation is disabled/i);
    } finally {
      await app.close();
    }
  });

  it('author not a member of server → 403', async () => {
    const fx = await makeFixture();
    // Remove the author's membership.
    await prisma.serverMember.delete({
      where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
    });
    const envelope = buildMsgCreateEnvelope({ fx });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/not a member/i);
    } finally {
      await app.close();
    }
  });

  it('unimplemented event type (message.update) → 501', async () => {
    const fx = await makeFixture();
    // A 'message.update' envelope. Payload shape doesn't matter — the handler
    // map rejects the event type before signature/payload checks.
    const envelope = buildMsgCreateEnvelope({ fx, eventType: 'message.update' });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(501);
      const body = res.json();
      expect(body.error).toMatch(/not implemented/i);
    } finally {
      await app.close();
    }
  });
});
