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

interface BuildUpdateEnvelopeInput {
  fx: PeerFixture;
  messageId: string;
  content?: string;
  editedAt?: string;
  /** Override author id placed in the payload (NOT the signing key — for forgery tests). */
  authorRemoteUserIdOverride?: string;
  /** Override the user-key used to sign the payload. */
  signUserOverride?: (bytes: Buffer) => Buffer;
  /** Override the instance-key used to sign the envelope. */
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildMsgUpdateEnvelope(input: BuildUpdateEnvelopeInput): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'message.update',
    fromInstance: PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      authorRemoteUserId: input.authorRemoteUserIdOverride ?? fx.authorRemoteUserId,
      messageId: input.messageId,
      content: input.content ?? 'edited from peer',
      editedAt: input.editedAt ?? new Date().toISOString(),
    },
    signUser: input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

interface BuildReactionEnvelopeInput {
  fx: PeerFixture;
  messageId: string;
  emoji?: string;
  /** Override actor id placed in the payload. */
  actorRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildReactionAddEnvelope(input: BuildReactionEnvelopeInput): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'reaction.add',
    fromInstance: PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      actorRemoteUserId: input.actorRemoteUserIdOverride ?? fx.authorRemoteUserId,
      messageId: input.messageId,
      emoji: input.emoji ?? '👍',
    },
    signUser: input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

function buildReactionRemoveEnvelope(input: BuildReactionEnvelopeInput): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'reaction.remove',
    fromInstance: PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      actorRemoteUserId: input.actorRemoteUserIdOverride ?? fx.authorRemoteUserId,
      messageId: input.messageId,
      emoji: input.emoji ?? '👍',
    },
    signUser: input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

interface BuildDeleteEnvelopeInput {
  fx: PeerFixture;
  messageId: string;
  deletedAt?: string;
  /** Override actor id placed in the payload. */
  actorRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildMsgDeleteEnvelope(input: BuildDeleteEnvelopeInput): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'message.delete',
    fromInstance: PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      actorRemoteUserId: input.actorRemoteUserIdOverride ?? fx.authorRemoteUserId,
      messageId: input.messageId,
      deletedAt: input.deletedAt ?? new Date().toISOString(),
    },
    signUser: input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

/**
 * Seed a federated Message row for the fixture's author — used as the
 * target of subsequent update/delete envelopes. Inserts directly via
 * Prisma so the test doesn't depend on the create-inbound path; the
 * row mimics what `handleMessageCreate` would have produced (origin
 * instance set, content + author + channel populated).
 */
async function seedFederatedMessage(opts: {
  fx: PeerFixture;
  messageId: string;
  content?: string;
}): Promise<void> {
  await prisma.message.create({
    data: {
      id: opts.messageId,
      serverId: opts.fx.serverId,
      channelId: opts.fx.channelId,
      authorId: opts.fx.localUserId,
      type: 'default',
      content: opts.content ?? 'original federated content',
      originInstanceId: opts.fx.peerInstanceId,
      signature: Buffer.alloc(64, 7),
    },
  });
}

/**
 * Seed a SECOND remote user on the same peer fixture. Used by the
 * non-author edit/delete rejection tests where the envelope is signed
 * by a different actor than the original author of the message.
 */
async function seedSecondRemoteUser(fx: PeerFixture): Promise<{
  kp: ReturnType<typeof generateKeyPair>;
  remoteUserId: string;
  localUserId: string;
}> {
  const kp = generateKeyPair();
  const remoteUserId = ulid();
  const localpart = `bob-${remoteUserId.slice(-6).toLowerCase()}`;
  const qualifiedId = `${localpart}@${PEER_HOST}`;
  await prisma.remoteUser.create({
    data: {
      id: remoteUserId,
      remoteInstanceId: fx.peerInstanceId,
      remoteUserId: qualifiedId,
      displayNameCache: 'Bob from B',
      avatarUrlCache: null,
      publicKey: exportPublicKeyRaw(kp.publicKey),
      lastSeenAt: new Date(0),
    },
  });
  const localUserId = ulid();
  const syntheticUsername = `__rem_${ulid().toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: localUserId,
      username: syntheticUsername,
      usernameLower: syntheticUsername,
      displayName: 'Bob from B',
      email: `${qualifiedId}.federated.local`,
      emailLower: `${qualifiedId}.federated.local`,
      passwordHash: null,
      remoteUserId: qualifiedId,
      remoteInstanceId: fx.peerInstanceId,
      federationKeyPublic: exportPublicKeyRaw(kp.publicKey),
    },
  });
  await prisma.serverMember.create({ data: { serverId: fx.serverId, userId: localUserId } });
  return { kp, remoteUserId: qualifiedId, localUserId };
}

async function cleanDb(): Promise<void> {
  // Order matters — children before parents.
  await prisma.federationEnvelopeLog.deleteMany({});
  await prisma.messageEdit.deleteMany({});
  await prisma.messageReaction.deleteMany({});
  await prisma.userMention.deleteMany({});
  await prisma.pinnedMessage.deleteMany({});
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

  it('unimplemented event type (reaction.add) → 501', async () => {
    const fx = await makeFixture();
    // A 'reaction.add' envelope. Payload shape doesn't matter — the handler
    // map rejects the event type before signature/payload checks.
    // (P3-8 added message.update + message.delete; reactions land in P3-9.)
    const envelope = buildMsgCreateEnvelope({ fx, eventType: 'reaction.add' });
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

  it('previousInstanceKey overlap: envelope signed by previous key still verifies', async () => {
    // Simulate a peer that has rotated its instance key. We give the peer a
    // NEW key as `instanceKey` and the OLD key as `previousInstanceKey`. An
    // envelope signed with the OLD key must still verify (rotation overlap
    // window — the peer doesn't know we don't have its new key yet).
    const fx = await makeFixture();
    // Replace the peer's instance key with a freshly-rotated keypair, and
    // record the keypair we generated in `makeFixture` as the previous key.
    const newKp = generateKeyPair();
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: {
        instanceKey: exportPublicKeyRaw(newKp.publicKey),
        previousInstanceKey: exportPublicKeyRaw(fx.peerKp.publicKey),
      },
    });

    // Envelope is signed with the OLD instance key (fx.peerKp). This is
    // what a peer mid-rotation would send if they hadn't yet completed
    // re-handshaking with this instance.
    const messageId = ulid();
    const envelope = buildMsgCreateEnvelope({
      fx,
      messageId,
      content: 'signed with previous instance key',
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
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

      // The message row must have been persisted normally — the rotation
      // fallback is transparent to the handler.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row).not.toBeNull();
      expect(row!.content).toBe('signed with previous instance key');

      // And a third, unrelated key must still be rejected — the fallback
      // accepts ONLY the previous-key rotation window, not any old key.
      const attacker = generateKeyPair();
      const rejected = buildMsgCreateEnvelope({
        fx,
        signInstanceOverride: (b: Buffer) => edSign(b, attacker.privateKey),
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: rejected,
      });
      expect(res2.statusCode).toBe(401);
      const body2 = res2.json();
      expect(body2.error).toMatch(/instance signature/i);
    } finally {
      await app.close();
    }
  });

  it('previousInstanceKey fallback does NOT cover user-signature failures', async () => {
    // Defence-in-depth: the rotation fallback exists for instance-key
    // rotation only. A user-signature failure must still be a hard 401
    // even when previousInstanceKey is set, otherwise an attacker could
    // forge user signatures and have them silently swallowed by the retry.
    const fx = await makeFixture();
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: {
        previousInstanceKey: exportPublicKeyRaw(generateKeyPair().publicKey),
      },
    });

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

  it('FK violation on replyToMessageId rolls back the envelope log atomically', async () => {
    // Confirm the envelope-log write + message create live in the same
    // transaction. A non-existent `replyToMessageId` triggers a P2003 FK
    // violation on Message.replyTo_fkey; the whole transaction must roll
    // back so the peer can retry without colliding on the unique nonce.
    const fx = await makeFixture();
    const orphanReplyId = ulid(); // not in DB

    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: PEER_HOST,
      toInstance: SELF_HOST,
      payload: {
        authorRemoteUserId: fx.authorRemoteUserId,
        channelId: fx.channelId,
        messageId: ulid(),
        content: 'replying to a ghost',
        replyToMessageId: orphanReplyId,
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
      // Specific status doesn't matter — what matters is that it's a 4xx/5xx
      // error AND that the envelope log was NOT committed.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);

      // The transaction must have rolled back: no envelope log row, no
      // message row.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, nonce: envelope.nonce },
      });
      expect(log).toBeNull();
      const msg = await prisma.message.findFirst({
        where: { channelId: fx.channelId },
      });
      expect(msg).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P3-8 — POST /_federation/event (message.update)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: updates content + editedAt and appends MessageEdit history', async () => {
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId, content: 'before edit' });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const editedAt = new Date('2026-05-19T13:00:00.000Z').toISOString();
    const envelope = buildMsgUpdateEnvelope({
      fx,
      messageId,
      content: 'after edit',
      editedAt,
    });
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
      expect(row!.content).toBe('after edit');
      expect(row!.editedAt?.toISOString()).toBe(editedAt);

      // History row preserves the pre-edit content.
      const edits = await prisma.messageEdit.findMany({ where: { messageId } });
      expect(edits).toHaveLength(1);
      expect(edits[0]!.content).toBe('before edit');
      expect(edits[0]!.editedBy).toBe(fx.localUserId);

      // RemoteUser.lastSeenAt should have moved forward.
      const updatedRemoteUser = await prisma.remoteUser.findUnique({
        where: { id: fx.remoteUserId },
      });
      expect(updatedRemoteUser!.lastSeenAt.getTime()).toBeGreaterThan(0);

      // Envelope log row exists for this peer + event type.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'message.update' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      await app.close();
    }
  });

  it('non-author edit → 403 forbidden', async () => {
    // Seed a federated message for the author (alice), then send a
    // message.update envelope signed by a DIFFERENT remote user (bob) on
    // the same peer. The author check on the inbound handler must reject
    // the edit with 403 regardless of the valid two-layer signature.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId, content: 'alice wrote this' });
    const bob = await seedSecondRemoteUser(fx);

    const envelope = buildMsgUpdateEnvelope({
      fx,
      messageId,
      content: 'bob tries to edit',
      authorRemoteUserIdOverride: bob.remoteUserId,
      signUserOverride: (b: Buffer) => edSign(b, bob.kp.privateKey),
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
      expect(body.error).toMatch(/not the author/i);

      // Confirm the row was NOT modified.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.content).toBe('alice wrote this');
      expect(row!.editedAt).toBeNull();
      const edits = await prisma.messageEdit.findMany({ where: { messageId } });
      expect(edits).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('edit of non-existent message → 404', async () => {
    const fx = await makeFixture();
    const envelope = buildMsgUpdateEnvelope({
      fx,
      messageId: ulid(), // never persisted
      content: 'edits a ghost',
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

  it('edit of already-deleted message → 404', async () => {
    // Phase 3 invariant: editing a tombstoned row makes no sense. The local
    // PATCH handler gates on `!message.deletedAt`; the inbound handler mirrors
    // that with an `unknown_message` (404) response.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: '' },
    });
    const envelope = buildMsgUpdateEnvelope({
      fx,
      messageId,
      content: 'edit after delete',
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P3-8 — POST /_federation/event (message.delete)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: soft-deletes message and cleans reactions/mentions/pins', async () => {
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId, content: 'about to be deleted' });

    // Sprinkle some collateral that the soft-delete must clean up: a
    // reaction, a mention, and a pin against the target message.
    await prisma.messageReaction.create({
      data: { messageId, userId: fx.localUserId, emoji: ':thumbsup:' },
    });
    await prisma.userMention.create({
      data: {
        id: ulid(),
        userId: fx.localUserId,
        messageId,
        channelId: fx.channelId,
        kind: 'user',
      },
    });
    await prisma.pinnedMessage.create({
      data: {
        messageId,
        channelId: fx.channelId,
        pinnedBy: fx.localUserId,
      },
    });

    const deletedAt = new Date('2026-05-19T14:00:00.000Z').toISOString();
    const envelope = buildMsgDeleteEnvelope({ fx, messageId, deletedAt });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);

      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt).not.toBeNull();
      expect(row!.deletedAt?.toISOString()).toBe(deletedAt);
      expect(row!.content).toBe('');

      // Collateral cleaned: no reactions, no mentions, no pins.
      const reactionCount = await prisma.messageReaction.count({ where: { messageId } });
      expect(reactionCount).toBe(0);
      const mentionCount = await prisma.userMention.count({ where: { messageId } });
      expect(mentionCount).toBe(0);
      const pinCount = await prisma.pinnedMessage.count({ where: { messageId } });
      expect(pinCount).toBe(0);

      // Envelope log row exists for this peer + event type.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'message.delete' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      await app.close();
    }
  });

  it('non-author delete → 403 forbidden', async () => {
    // Phase 3: only the original author can delete. Even a validly-signed
    // envelope from a different remote user on the same peer (e.g. a
    // moderator) is rejected — moderator-driven federated deletes are a
    // Phase 7 problem and out of scope here.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    const bob = await seedSecondRemoteUser(fx);

    const envelope = buildMsgDeleteEnvelope({
      fx,
      messageId,
      actorRemoteUserIdOverride: bob.remoteUserId,
      signUserOverride: (b: Buffer) => edSign(b, bob.kp.privateKey),
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
      expect(body.error).toMatch(/not the author/i);

      // Confirm the row is unchanged.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('delete of non-existent message → 404', async () => {
    const fx = await makeFixture();
    const envelope = buildMsgDeleteEnvelope({ fx, messageId: ulid() });
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

  it('delete of already-deleted message → 200 idempotent', async () => {
    // A second delete envelope (different nonce, e.g. peer outbox retried
    // after the first one committed) is a no-op rather than a 404 / 409.
    // The replay log keys on `(peerInstanceId, nonce)`, so a DIFFERENT
    // envelope can still arrive — the handler is idempotent for that case.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    const deletedAt = new Date();
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt, content: '' },
    });

    const envelope = buildMsgDeleteEnvelope({ fx, messageId });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data?.deduplicated).toBe(true);

      // deletedAt unchanged — the original delete time is preserved.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt?.getTime()).toBe(deletedAt.getTime());
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P3-9 — POST /_federation/event (reaction.add)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: creates a MessageReaction row with the actor mapped to local user', async () => {
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId, content: 'reactable' });

    const envelope = buildReactionAddEnvelope({ fx, messageId, emoji: '👍' });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);

      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
      });
      expect(rows).toHaveLength(1);
      // Actor's LOCAL User id, not the remote-user-id string.
      expect(rows[0]!.userId).toBe(fx.localUserId);
      expect(rows[0]!.emoji).toBe('👍');

      // Envelope log row recorded.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'reaction.add' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');

      // RemoteUser.lastSeenAt must have moved forward.
      const updatedRemoteUser = await prisma.remoteUser.findUnique({
        where: { id: fx.remoteUserId },
      });
      expect(updatedRemoteUser!.lastSeenAt.getTime()).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('idempotent: receiving the same reaction twice does not duplicate the row', async () => {
    // Two envelopes from the same peer carry different nonces, so the
    // envelope-log replay filter does NOT catch them — the handler itself
    // must short-circuit via the unique composite key (messageId, userId,
    // emoji).
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const e1 = buildReactionAddEnvelope({ fx, messageId, emoji: '👍' });
      const r1 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: e1,
      });
      expect(r1.statusCode).toBe(200);

      const e2 = buildReactionAddEnvelope({ fx, messageId, emoji: '👍' });
      const r2 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: e2,
      });
      expect(r2.statusCode).toBe(200);

      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
      });
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('reaction on non-existent message → 404', async () => {
    const fx = await makeFixture();
    const envelope = buildReactionAddEnvelope({ fx, messageId: ulid() });
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

  it('reaction on a force_off channel → 403', async () => {
    const fx = await makeFixture({ channelFederationMode: 'force_off' });
    const messageId = ulid();
    // Seed the row directly — the local table is still queryable even though
    // the channel forbids federation.
    await prisma.message.create({
      data: {
        id: messageId,
        serverId: fx.serverId,
        channelId: fx.channelId,
        authorId: fx.localUserId,
        type: 'default',
        content: 'in a force-off room',
        originInstanceId: fx.peerInstanceId,
        signature: Buffer.alloc(64, 7),
      },
    });
    const envelope = buildReactionAddEnvelope({ fx, messageId });
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

  it('reaction from a non-server-member → 403', async () => {
    // The reactor (the actor) MUST be a ServerMember of the channel's server.
    // Remove the membership we set up in `makeFixture` and the handler must
    // bail out before writing the MessageReaction row.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    await prisma.serverMember.delete({
      where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
    });

    const envelope = buildReactionAddEnvelope({ fx, messageId });
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

      // No reaction written.
      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
      });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('reaction with a custom: emoji reference → 403 (Phase 4+ deferral)', async () => {
    // Custom emojis don't cross federation in Phase 3. The id only resolves
    // on the home instance, and we have no story for transporting the bytes.
    // The inbound handler MUST reject any `custom:` payload regardless of
    // signature.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });

    const envelope = buildReactionAddEnvelope({
      fx,
      messageId,
      emoji: 'custom:01HXEXAMPLEXAMPLEXAMPLEAA',
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
      expect(body.error).toMatch(/custom emojis do not cross federation/i);

      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
      });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('reaction on a soft-deleted message → 404 (no reacting to tombstones)', async () => {
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: '' },
    });

    const envelope = buildReactionAddEnvelope({ fx, messageId });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P3-9 — POST /_federation/event (reaction.remove)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: removes an existing MessageReaction row', async () => {
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    await prisma.messageReaction.create({
      data: { messageId, userId: fx.localUserId, emoji: '👍' },
    });

    const envelope = buildReactionRemoveEnvelope({ fx, messageId, emoji: '👍' });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
      });
      expect(rows).toHaveLength(0);

      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'reaction.remove' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      await app.close();
    }
  });

  it('idempotent: removing a non-existent reaction is a no-op (200)', async () => {
    // Mirrors the local DELETE route, which swallows P2025. A peer that
    // retries a remove after the row is already gone should not see a
    // hard error.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });
    // Do NOT pre-create a reaction.

    const envelope = buildReactionRemoveEnvelope({ fx, messageId, emoji: '👍' });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      // No reaction was created as a side-effect of the no-op remove.
      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
      });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('remove on non-existent message → 404', async () => {
    const fx = await makeFixture();
    const envelope = buildReactionRemoveEnvelope({ fx, messageId: ulid() });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('remove with a custom: emoji reference → 403', async () => {
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });

    const envelope = buildReactionRemoveEnvelope({
      fx,
      messageId,
      emoji: 'custom:01HXEXAMPLEXAMPLEXAMPLEAA',
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
      expect(body.error).toMatch(/custom emojis do not cross federation/i);
    } finally {
      await app.close();
    }
  });
});
