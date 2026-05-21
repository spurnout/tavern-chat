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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { gatewayBroker } from '../src/services/gateway-broker.js';
import {
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  canonicalize,
  generateKeyPair,
  exportPublicKeyRaw,
  publicKeyFromRaw,
  sign as edSign,
  verify as edVerify,
  buildTwoLayerMessageEnvelope,
  verifyTwoLayerMessageEnvelope,
  type FederationOutboxJob,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import {
  PROTOCOL_VERSION,
  messageCreatePayloadSchema,
  type MemberJoinedPayload,
} from '@tavern/shared';

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
  eventType?:
    | 'message.create'
    | 'message.update'
    | 'message.delete'
    | 'reaction.add'
    | 'reaction.remove'
    | 'member.removed';
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
  await prisma.dmChannelMember.deleteMany({});
  await prisma.dmChannel.deleteMany({});
  await prisma.invite.deleteMany({});
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

  it('unimplemented event type (member.removed) → 501', async () => {
    const fx = await makeFixture();
    // A 'member.removed' envelope. Payload shape doesn't matter — the handler
    // map rejects the event type before signature/payload checks.
    // `member.removed` is intentionally not registered in HANDLERS (it's the
    // single-layer ack consumed inline by the synchronous `member.leave`
    // route — see P4-15 / the comment block at the bottom of HANDLERS in
    // `federation-inbound.ts`), so a peer that posts one to /_federation/event
    // gets a 501. We use it here as a stable "always-501" event type now that
    // every previously-unimplemented entry has gained a handler.
    const envelope = buildMsgCreateEnvelope({ fx, eventType: 'member.removed' });
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

  it('edit on a force_off channel → 403 (effective-federation gate)', async () => {
    // Asymmetric-state scenario from the spec: an operator flips the channel
    // to `federationMode='force_off'` AFTER the original create landed. The
    // inbound update handler must re-evaluate the effective gate on every
    // envelope, even when the row was originally accepted with federation
    // on. Without the gate the edit would silently land + broadcast in a
    // channel that's no longer accepting federated content — exactly the
    // bug Phase-3 code review caught.
    const fx = await makeFixture({ channelFederationMode: 'force_off' });
    const messageId = ulid();
    // Seed the row directly so the create-time gate doesn't intervene; the
    // bug being tested is the *update* path missing the check.
    await prisma.message.create({
      data: {
        id: messageId,
        serverId: fx.serverId,
        channelId: fx.channelId,
        authorId: fx.localUserId,
        type: 'default',
        content: 'pre-flip content',
        originInstanceId: fx.peerInstanceId,
        signature: Buffer.alloc(64, 7),
      },
    });

    const envelope = buildMsgUpdateEnvelope({
      fx,
      messageId,
      content: 'attempted edit after flip',
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
      expect(body.error).toMatch(/federation is disabled/i);

      // The row must be unchanged — neither content nor editedAt mutate.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.content).toBe('pre-flip content');
      expect(row!.editedAt).toBeNull();
      // And no MessageEdit history was written.
      const edits = await prisma.messageEdit.findMany({ where: { messageId } });
      expect(edits).toHaveLength(0);
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

  it('delete on a force_off channel → 403 (effective-federation gate)', async () => {
    // Same asymmetric-state scenario as the update test: the channel was
    // flipped to `force_off` AFTER the original create. A subsequent delete
    // envelope must be rejected — the inbound handler enforces its own gate
    // even when the row was originally accepted with federation on.
    const fx = await makeFixture({ channelFederationMode: 'force_off' });
    const messageId = ulid();
    await prisma.message.create({
      data: {
        id: messageId,
        serverId: fx.serverId,
        channelId: fx.channelId,
        authorId: fx.localUserId,
        type: 'default',
        content: 'pre-flip content',
        originInstanceId: fx.peerInstanceId,
        signature: Buffer.alloc(64, 7),
      },
    });

    const envelope = buildMsgDeleteEnvelope({ fx, messageId });
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

      // The row must NOT be tombstoned.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt).toBeNull();
      expect(row!.content).toBe('pre-flip content');
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

  it('reaction with an UPPERCASE CUSTOM: emoji reference → 403 (case-insensitive gate)', async () => {
    // The upstream Zod schema validates emoji as a free-form string, so a
    // case-sensitive `custom:` check could be bypassed with `CUSTOM:abc`.
    // The inbound handler MUST lowercase before comparing.
    const fx = await makeFixture();
    const messageId = ulid();
    await seedFederatedMessage({ fx, messageId });

    const envelope = buildReactionAddEnvelope({
      fx,
      messageId,
      emoji: 'CUSTOM:abc123',
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

describe.skipIf(!dockerOk)('P4-7 — POST /_federation/event (member.join_request)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  /**
   * Variant of makeFixture that also creates a federated invite minted on
   * THIS instance (the home A side). Returns the fixture plus the invite
   * details needed for the join_request envelope.
   *
   * The fixture's `localUserId` represents a synthetic mirror user of the
   * remote joiner (alice@b.example). The handler will ALSO call
   * ensureUserForRemoteUser; the unique constraint on remoteUserId makes
   * both calls idempotent.
   */
  async function makeJoinFixture(opts?: {
    remoteScope?: 'any_peer' | 'specific_instance' | 'specific_user';
    remoteInstanceHost?: string | null;
    remoteUserIdOnInvite?: string | null;
    maxUses?: number | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
    extraLocalMembers?: number;
  }): Promise<{
    fx: PeerFixture;
    inviteId: string;
    inviteCode: string;
    extraLocalMemberIds: string[];
  }> {
    const fx = await makeFixture();
    const inviteId = ulid();
    const inviteCode = `INV-${ulid().slice(-8)}`;
    const remoteScope = opts?.remoteScope ?? 'any_peer';

    // The joiner row already exists (makeFixture seeded it). For tests
    // where we want extra local members in the roster, add them here.
    const extraIds: string[] = [];
    for (let i = 0; i < (opts?.extraLocalMembers ?? 0); i++) {
      const id = ulid();
      const username = `extra-${id.slice(-6).toLowerCase()}`;
      await prisma.user.create({
        data: {
          id,
          username,
          usernameLower: username,
          displayName: `Extra ${i}`,
          email: `${username}@example.com`,
          emailLower: `${username}@example.com`,
          passwordHash: 'x',
        },
      });
      await prisma.serverMember.create({
        data: { serverId: fx.serverId, userId: id },
      });
      extraIds.push(id);
    }

    // Drop the joiner's pre-seeded membership — the handler will create
    // it as part of the redeem flow. Without this the happy-path test
    // can't distinguish a freshly-created membership from the pre-seed.
    await prisma.serverMember.delete({
      where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
    });

    await prisma.invite.create({
      data: {
        id: inviteId,
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        createdById: null,
        maxUses: opts?.maxUses === undefined ? null : opts.maxUses,
        uses: 0,
        expiresAt: opts?.expiresAt ?? null,
        revokedAt: opts?.revokedAt ?? null,
        remoteScope,
        remoteInstanceHost:
          opts?.remoteInstanceHost === undefined
            ? remoteScope === 'any_peer'
              ? null
              : PEER_HOST
            : opts.remoteInstanceHost,
        remoteUserId:
          opts?.remoteUserIdOnInvite === undefined
            ? remoteScope === 'specific_user'
              ? fx.authorRemoteUserId
              : null
            : opts.remoteUserIdOnInvite,
      },
    });

    return { fx, inviteId, inviteCode, extraLocalMemberIds: extraIds };
  }

  function buildJoinRequestEnvelope(input: {
    fx: PeerFixture;
    inviteCode: string;
    joinerRemoteUserIdOverride?: string;
    signUserOverride?: (bytes: Buffer) => Buffer;
    signInstanceOverride?: (bytes: Buffer) => Buffer;
  }): TwoLayerSignedEnvelope<unknown> {
    const { fx } = input;
    return buildTwoLayerMessageEnvelope({
      eventType: 'member.join_request',
      fromInstance: PEER_HOST,
      toInstance: SELF_HOST,
      payload: {
        inviteCode: input.inviteCode,
        joinerRemoteUserId:
          input.joinerRemoteUserIdOverride ?? fx.authorRemoteUserId,
      },
      signUser:
        input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
      signInstance:
        input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
    });
  }

  /**
   * Assert that the response body parses as a signed envelope of the
   * given event type, signed by THIS instance's federation key. Returns
   * the typed payload for further assertions.
   */
  async function assertSignedReply(
    body: unknown,
    expectedEventType: 'member.joined',
  ): Promise<MemberJoinedPayload> {
    expect(body).toMatchObject({
      version: PROTOCOL_VERSION,
      eventType: expectedEventType,
      fromInstance: SELF_HOST,
      toInstance: PEER_HOST,
    });

    const env = body as {
      payload: MemberJoinedPayload;
      signature: string;
      version: string;
      eventType: string;
      nonce: string;
      notBefore: string;
      notAfter: string;
      fromInstance: string;
      toInstance: string;
    };

    // Pull this instance's federation public key from the DB and verify
    // the signature over canonical(envelope-minus-signature).
    const keyRow = await prisma.federationKey.findFirstOrThrow({
      where: { isCurrent: true },
    });
    const pub = publicKeyFromRaw(Buffer.from(keyRow.publicKey));
    const { signature, ...unsigned } = env;
    const bytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
    expect(edVerify(bytes, Buffer.from(signature, 'base64'), pub)).toBe(true);

    return env.payload;
  }

  // ─── 1. Happy path ─────────────────────────────────────────────────────────

  it('happy path: redeems invite, creates ServerMember, returns signed snapshot', async () => {
    const { fx, inviteCode, inviteId } = await makeJoinFixture({
      remoteScope: 'any_peer',
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      const replyPayload = await assertSignedReply(body, 'member.joined');
      expect(replyPayload.inviteCode).toBe(inviteCode);
      expect(replyPayload.serverSnapshot.serverId).toBe(fx.serverId);
      expect(replyPayload.serverSnapshot.federationEnabled).toBe(true);

      // ServerMember was inserted for the joiner.
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
      });
      expect(member).not.toBeNull();

      // Invite uses incremented from 0 → 1.
      const invite = await prisma.invite.findUniqueOrThrow({
        where: { id: inviteId },
      });
      expect(invite.uses).toBe(1);

      // Snapshot includes the joiner. The makeFixture sets up an owner
      // (local) and a synthetic mirror user (the joiner — Alice from B);
      // both should appear.
      const remoteUserIds = replyPayload.serverSnapshot.members.map(
        (m) => m.remoteUserId,
      );
      expect(remoteUserIds).toContain(fx.authorRemoteUserId);
    } finally {
      await app.close();
    }
  });

  // ─── 2. Invalid invite code → 404 ─────────────────────────────────────────

  it('unknown invite code → 404', async () => {
    const { fx } = await makeJoinFixture({ remoteScope: 'any_peer' });
    const envelope = buildJoinRequestEnvelope({
      fx,
      inviteCode: 'DOES-NOT-EXIST',
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
      expect(body.error).toMatch(/invite .* not found/i);
    } finally {
      await app.close();
    }
  });

  // ─── 3. Invite expired → 410 ──────────────────────────────────────────────

  it('expired invite → 410', async () => {
    const { fx, inviteCode } = await makeJoinFixture({
      remoteScope: 'any_peer',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(410);
      const body = res.json();
      expect(body.error).toMatch(/expired/i);
    } finally {
      await app.close();
    }
  });

  // ─── 4. Invite revoked → 410 ──────────────────────────────────────────────

  it('revoked invite → 410', async () => {
    const { fx, inviteCode } = await makeJoinFixture({
      remoteScope: 'any_peer',
      revokedAt: new Date(),
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(410);
      const body = res.json();
      expect(body.error).toMatch(/revoked/i);
    } finally {
      await app.close();
    }
  });

  // ─── 5. Invite exhausted (uses >= maxUses) → 410 ──────────────────────────

  it('exhausted invite (uses >= maxUses) → 410', async () => {
    const { fx, inviteCode, inviteId } = await makeJoinFixture({
      remoteScope: 'any_peer',
      maxUses: 1,
    });
    // Bump uses to maxUses so the initial validity check trips.
    await prisma.invite.update({ where: { id: inviteId }, data: { uses: 1 } });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(410);
      const body = res.json();
      expect(body.error).toMatch(/fully used/i);
    } finally {
      await app.close();
    }
  });

  // ─── 6. Local-only invite (remoteScope=null) → 404 ────────────────────────

  it('local-only invite (remoteScope null) → 404 (does not leak existence)', async () => {
    // Set up the rest of the fixture but make the invite local-only.
    const fx = await makeFixture();
    await prisma.serverMember.delete({
      where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
    });
    const inviteCode = `LOCAL-${ulid().slice(-8)}`;
    await prisma.invite.create({
      data: {
        id: ulid(),
        code: inviteCode,
        scope: 'server',
        serverId: fx.serverId,
        maxUses: null,
        uses: 0,
        expiresAt: null,
        revokedAt: null,
        // remoteScope is null → not a federated invite.
        remoteScope: null,
      },
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      // Same message as the unknown-code branch: a peer cannot distinguish
      // a missing invite from a local-only one.
      expect(body.error).toMatch(/invite .* not found/i);
    } finally {
      await app.close();
    }
  });

  // ─── 7. specific_instance mismatch → 403 ──────────────────────────────────

  it('specific_instance invite from wrong peer → 403', async () => {
    const { fx, inviteCode } = await makeJoinFixture({
      remoteScope: 'specific_instance',
      remoteInstanceHost: 'someone-else.example',
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/scoped to/i);
    } finally {
      await app.close();
    }
  });

  // ─── 8. specific_user mismatch → 403 ──────────────────────────────────────

  it('specific_user invite with wrong joinerRemoteUserId → 403', async () => {
    const { fx, inviteCode } = await makeJoinFixture({
      remoteScope: 'specific_user',
      // Invite is pinned to a DIFFERENT remote user on the same host.
      remoteUserIdOnInvite: `someone-else@${PEER_HOST}`,
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/scoped to a different user/i);
    } finally {
      await app.close();
    }
  });

  // ─── 9. Idempotent same joiner: second envelope succeeds, uses NOT double-incremented

  it('idempotent same joiner: 2x envelopes → both 200, uses incremented only once', async () => {
    const { fx, inviteCode, inviteId } = await makeJoinFixture({
      remoteScope: 'any_peer',
    });
    // Build TWO envelopes — different nonces so the replay log doesn't
    // drop the second. The handler-level idempotency (P2002 catch on
    // ServerMember.create) is what we're exercising.
    const env1 = buildJoinRequestEnvelope({ fx, inviteCode });
    const env2 = buildJoinRequestEnvelope({ fx, inviteCode });
    expect(env1.nonce).not.toBe(env2.nonce);

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: env1,
      });
      expect(r1.statusCode).toBe(200);

      const r2 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: env2,
      });
      expect(r2.statusCode).toBe(200);

      // Exactly one ServerMember row for the joiner — the second attempt
      // hit the P2002 path and dedup'd.
      const members = await prisma.serverMember.findMany({
        where: { serverId: fx.serverId, userId: fx.localUserId },
      });
      expect(members).toHaveLength(1);

      // Invite.uses incremented only once across the two calls.
      const invite = await prisma.invite.findUniqueOrThrow({
        where: { id: inviteId },
      });
      expect(invite.uses).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ─── 10. Snapshot includes prior members + the new joiner ─────────────────

  it('snapshot member roster includes prior members + joiner', async () => {
    const { fx, inviteCode, extraLocalMemberIds } = await makeJoinFixture({
      remoteScope: 'any_peer',
      extraLocalMembers: 2,
    });
    const envelope = buildJoinRequestEnvelope({ fx, inviteCode });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const replyPayload = await assertSignedReply(body, 'member.joined');

      // Owner + 2 extras + joiner = 4 members.
      expect(replyPayload.serverSnapshot.members).toHaveLength(4);

      // Each extra local member appears with a `<localpart>@<selfHost>`
      // qualified id (they're LOCAL users on this instance).
      const remoteUserIds = replyPayload.serverSnapshot.members.map(
        (m) => m.remoteUserId,
      );
      for (const extraId of extraLocalMemberIds) {
        const extra = await prisma.user.findUniqueOrThrow({
          where: { id: extraId },
          select: { username: true },
        });
        expect(remoteUserIds).toContain(`${extra.username}@${SELF_HOST}`);
      }

      // Joiner is in the roster too — qualified id matches the verified
      // RemoteUser.remoteUserId.
      expect(remoteUserIds).toContain(fx.authorRemoteUserId);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// P4-8 — inbound server.update + channel.create/update/delete (mirror lifecycle)
// ============================================================================

/**
 * For these handlers THIS instance is the B side — we hold a MIRROR of a
 * Server owned by the peer A. The peer pushes envelopes to mutate the
 * mirror; our handlers must:
 *   1. Reject envelopes from non-origin peers (403 `not_origin`).
 *   2. Reject envelopes targeting a serverId we don't have a mirror for
 *      (404 `unknown_mirror_server`).
 *   3. Mirror the mutation idempotently and broadcast the local gateway
 *      event so any client viewing the mirror sees the change.
 *
 * Setup differs from `makeFixture` (which builds a LOCAL server) — these
 * tests need a mirror Server (originInstanceId set) owned by the peer's
 * RemoteUser via a synthetic local User row.
 */
interface MirrorFixture extends PeerFixture {
  /** The mirror Server's row — owner is the synthetic Alice user */
  mirrorServerId: string;
  /** The single channel that exists on the mirror at setup time */
  mirrorChannelId: string;
}

async function makeMirrorFixture(opts?: {
  /** Optional override for the channel federationMode */
  channelFederationMode?: 'inherit' | 'force_on' | 'force_off';
}): Promise<MirrorFixture> {
  // Reuse the underlying peer + remote user fixture; we won't use its
  // serverId (which is a LOCAL server). The mirror Server's owner is
  // the synthetic local user (`fx.localUserId`) so the
  // `User.remoteUserId` field populates `resolveMirrorOwner`.
  const fx = await makeFixture();

  const mirrorServerId = ulid();
  const everyoneRoleId = ulid();
  const mirrorChannelId = ulid();

  await prisma.server.create({
    data: {
      id: mirrorServerId,
      ownerUserId: fx.localUserId, // synthetic mirror user (has remoteUserId)
      name: 'Mirror of A',
      description: 'A peer-owned mirror',
      iconAttachmentId: null,
      federationEnabled: true,
      originInstanceId: fx.peerInstanceId, // <- this is what makes it a mirror
    },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId: mirrorServerId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE),
      ),
    },
  });
  await prisma.server.update({
    where: { id: mirrorServerId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: {
      id: mirrorChannelId,
      serverId: mirrorServerId,
      type: 'text',
      name: 'mirrored-general',
      federationMode: opts?.channelFederationMode ?? 'inherit',
      originInstanceId: fx.peerInstanceId,
    },
  });
  // Owner is also a member on the mirror — that's the pattern createMirrorServer
  // produces. We don't need additional members for these tests.
  await prisma.serverMember.create({
    data: { serverId: mirrorServerId, userId: fx.localUserId },
  });

  return { ...fx, mirrorServerId, mirrorChannelId };
}

interface BuildMirrorEnvelopeBase {
  fx: MirrorFixture;
  /** Override fromInstance — used for the non-origin peer 403 tests. */
  fromInstance?: string;
  /** Override the user-key used to sign the payload. */
  signUserOverride?: (bytes: Buffer) => Buffer;
  /** Override the instance-key used to sign the envelope. */
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildServerUpdateEnvelope(
  input: BuildMirrorEnvelopeBase & {
    serverId: string;
    name?: string;
    description?: string | null;
    iconUrl?: string | null;
  },
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  const payload: Record<string, unknown> = { serverId: input.serverId };
  if (input.name !== undefined) payload['name'] = input.name;
  if (input.description !== undefined) payload['description'] = input.description;
  if (input.iconUrl !== undefined) payload['iconUrl'] = input.iconUrl;
  return buildTwoLayerMessageEnvelope({
    eventType: 'server.update',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload,
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

function buildChannelCreateEnvelope(
  input: BuildMirrorEnvelopeBase & {
    serverId: string;
    channelId?: string;
    name?: string;
    type?: 'text' | 'forum';
    topic?: string | null;
    position?: number;
    federationMode?: 'inherit' | 'force_on' | 'force_off';
    nsfw?: boolean;
  },
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'channel.create',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      serverId: input.serverId,
      channel: {
        id: input.channelId ?? ulid(),
        name: input.name ?? 'new-channel',
        type: input.type ?? 'text',
        topic: input.topic ?? null,
        position: input.position ?? 0,
        federationMode: input.federationMode ?? 'inherit',
        nsfw: input.nsfw ?? false,
      },
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

function buildChannelUpdateEnvelope(
  input: BuildMirrorEnvelopeBase & {
    serverId: string;
    channelId: string;
    name?: string;
    topic?: string | null;
    position?: number;
    federationMode?: 'inherit' | 'force_on' | 'force_off';
    nsfw?: boolean;
  },
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  const payload: Record<string, unknown> = {
    serverId: input.serverId,
    channelId: input.channelId,
  };
  if (input.name !== undefined) payload['name'] = input.name;
  if (input.topic !== undefined) payload['topic'] = input.topic;
  if (input.position !== undefined) payload['position'] = input.position;
  if (input.federationMode !== undefined)
    payload['federationMode'] = input.federationMode;
  if (input.nsfw !== undefined) payload['nsfw'] = input.nsfw;
  return buildTwoLayerMessageEnvelope({
    eventType: 'channel.update',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload,
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

function buildChannelDeleteEnvelope(
  input: BuildMirrorEnvelopeBase & {
    serverId: string;
    channelId: string;
  },
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'channel.delete',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      serverId: input.serverId,
      channelId: input.channelId,
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

/**
 * Seed a second peered RemoteInstance — used by the `not_origin` tests where
 * we send an envelope from a DIFFERENT peer than the one that owns the mirror.
 * The second peer must be `peered` (else the dispatcher would 403 with
 * `peer_not_peered` first) and have a RemoteUser whose key signs the envelope.
 */
async function seedSecondPeer(): Promise<{
  peerInstanceId: string;
  peerHost: string;
  peerKp: ReturnType<typeof generateKeyPair>;
  authorKp: ReturnType<typeof generateKeyPair>;
  authorRemoteUserId: string;
}> {
  const peerHost = 'c.example';
  const peerInstanceId = ulid();
  const peerKp = generateKeyPair();
  const authorKp = generateKeyPair();
  const localpart = `mallory-${peerInstanceId.slice(-6).toLowerCase()}`;
  const authorRemoteUserId = `${localpart}@${peerHost}`;

  await prisma.remoteInstance.create({
    data: {
      id: peerInstanceId,
      host: peerHost,
      instanceKey: exportPublicKeyRaw(peerKp.publicKey),
      status: 'peered',
      capabilities: ['messages'],
      peeredAt: new Date(),
    },
  });
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: peerInstanceId,
      remoteUserId: authorRemoteUserId,
      displayNameCache: 'Mallory from C',
      avatarUrlCache: null,
      publicKey: exportPublicKeyRaw(authorKp.publicKey),
      lastSeenAt: new Date(0),
    },
  });
  return { peerInstanceId, peerHost, peerKp, authorKp, authorRemoteUserId };
}

describe.skipIf(!dockerOk)('P4-8 — POST /_federation/event (server.update)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: updates mirror surface fields + broadcasts SERVER_UPDATE', async () => {
    const fx = await makeMirrorFixture();
    const envelope = buildServerUpdateEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      name: 'Renamed Mirror',
      description: 'updated description',
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
      expect(body.data?.id).toBe(fx.mirrorServerId);

      const row = await prisma.server.findUniqueOrThrow({
        where: { id: fx.mirrorServerId },
      });
      expect(row.name).toBe('Renamed Mirror');
      expect(row.description).toBe('updated description');
      expect(row.originInstanceId).toBe(fx.peerInstanceId);

      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'server.update' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      await app.close();
    }
  });

  it('non-origin peer → 403 not_origin', async () => {
    const fx = await makeMirrorFixture();
    const other = await seedSecondPeer();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'server.update',
      fromInstance: other.peerHost,
      toInstance: SELF_HOST,
      payload: { serverId: fx.mirrorServerId, name: 'hijacked' },
      signUser: (b: Buffer) => edSign(b, other.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, other.peerKp.privateKey),
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
      expect(body.error).toMatch(/is not the origin/i);

      // The mirror row must NOT have been mutated.
      const row = await prisma.server.findUniqueOrThrow({
        where: { id: fx.mirrorServerId },
      });
      expect(row.name).toBe('Mirror of A');
    } finally {
      await app.close();
    }
  });

  it('unknown mirror server → 404 unknown_mirror_server', async () => {
    const fx = await makeMirrorFixture();
    const envelope = buildServerUpdateEnvelope({
      fx,
      serverId: ulid(), // no mirror with this id
      name: 'irrelevant',
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
      expect(body.error).toMatch(/mirror server .* not found/i);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P4-8 — POST /_federation/event (channel.create)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: creates mirror Channel + broadcasts CHANNEL_CREATE', async () => {
    const fx = await makeMirrorFixture();
    const newChannelId = ulid();
    const envelope = buildChannelCreateEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      channelId: newChannelId,
      name: 'announcements',
      type: 'text',
      topic: 'broadcasts from the home peer',
      position: 5,
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
      expect(body.data?.id).toBe(newChannelId);

      const row = await prisma.channel.findUniqueOrThrow({
        where: { id: newChannelId },
      });
      expect(row.serverId).toBe(fx.mirrorServerId);
      expect(row.name).toBe('announcements');
      expect(row.type).toBe('text');
      expect(row.topic).toBe('broadcasts from the home peer');
      expect(row.originInstanceId).toBe(fx.peerInstanceId);
    } finally {
      await app.close();
    }
  });

  it('non-origin peer → 403 not_origin', async () => {
    const fx = await makeMirrorFixture();
    const other = await seedSecondPeer();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'channel.create',
      fromInstance: other.peerHost,
      toInstance: SELF_HOST,
      payload: {
        serverId: fx.mirrorServerId,
        channel: {
          id: ulid(),
          name: 'hijacked',
          type: 'text',
          topic: null,
          position: 0,
          federationMode: 'inherit',
          nsfw: false,
        },
      },
      signUser: (b: Buffer) => edSign(b, other.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, other.peerKp.privateKey),
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
      expect(body.error).toMatch(/is not the origin/i);

      // No new channel created.
      const channels = await prisma.channel.count({
        where: { serverId: fx.mirrorServerId },
      });
      expect(channels).toBe(1); // only the seed channel
    } finally {
      await app.close();
    }
  });

  it('unknown mirror server → 404 unknown_mirror_server', async () => {
    const fx = await makeMirrorFixture();
    const envelope = buildChannelCreateEnvelope({
      fx,
      serverId: ulid(),
      name: 'orphan',
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
      expect(body.error).toMatch(/mirror server .* not found/i);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P4-8 — POST /_federation/event (channel.update)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: patches mirror Channel + broadcasts CHANNEL_UPDATE', async () => {
    const fx = await makeMirrorFixture();
    const envelope = buildChannelUpdateEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      channelId: fx.mirrorChannelId,
      name: 'renamed-general',
      topic: 'new topic',
      position: 7,
      nsfw: true,
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
      expect(body.data?.id).toBe(fx.mirrorChannelId);

      const row = await prisma.channel.findUniqueOrThrow({
        where: { id: fx.mirrorChannelId },
      });
      expect(row.name).toBe('renamed-general');
      expect(row.topic).toBe('new topic');
      expect(row.position).toBe(7);
      expect(row.nsfw).toBe(true);
      // Type and origin stay pinned.
      expect(row.type).toBe('text');
      expect(row.originInstanceId).toBe(fx.peerInstanceId);
    } finally {
      await app.close();
    }
  });

  it('non-origin peer → 403 not_origin', async () => {
    const fx = await makeMirrorFixture();
    const other = await seedSecondPeer();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'channel.update',
      fromInstance: other.peerHost,
      toInstance: SELF_HOST,
      payload: {
        serverId: fx.mirrorServerId,
        channelId: fx.mirrorChannelId,
        name: 'hijacked',
      },
      signUser: (b: Buffer) => edSign(b, other.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, other.peerKp.privateKey),
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
      expect(body.error).toMatch(/is not the origin/i);

      const row = await prisma.channel.findUniqueOrThrow({
        where: { id: fx.mirrorChannelId },
      });
      expect(row.name).toBe('mirrored-general');
    } finally {
      await app.close();
    }
  });

  it('unknown mirror server → 404 unknown_mirror_server', async () => {
    const fx = await makeMirrorFixture();
    const envelope = buildChannelUpdateEnvelope({
      fx,
      serverId: ulid(),
      channelId: fx.mirrorChannelId,
      name: 'irrelevant',
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
      expect(body.error).toMatch(/mirror server .* not found/i);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P4-8 — POST /_federation/event (channel.delete)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: removes mirror Channel + broadcasts CHANNEL_DELETE', async () => {
    const fx = await makeMirrorFixture();
    // Add a SECOND channel so the LAST-channel test below stays separate.
    const secondChannelId = ulid();
    await prisma.channel.create({
      data: {
        id: secondChannelId,
        serverId: fx.mirrorServerId,
        type: 'text',
        name: 'second',
        federationMode: 'inherit',
        originInstanceId: fx.peerInstanceId,
      },
    });

    const envelope = buildChannelDeleteEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      channelId: secondChannelId,
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
      expect(body.data?.id).toBe(secondChannelId);

      const row = await prisma.channel.findUnique({
        where: { id: secondChannelId },
      });
      expect(row).toBeNull();

      // Mirror Server + the other channel are still present.
      const server = await prisma.server.findUnique({
        where: { id: fx.mirrorServerId },
      });
      expect(server).not.toBeNull();
      const remaining = await prisma.channel.findMany({
        where: { serverId: fx.mirrorServerId },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(fx.mirrorChannelId);
    } finally {
      await app.close();
    }
  });

  it('non-origin peer → 403 not_origin', async () => {
    const fx = await makeMirrorFixture();
    const other = await seedSecondPeer();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'channel.delete',
      fromInstance: other.peerHost,
      toInstance: SELF_HOST,
      payload: {
        serverId: fx.mirrorServerId,
        channelId: fx.mirrorChannelId,
      },
      signUser: (b: Buffer) => edSign(b, other.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, other.peerKp.privateKey),
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
      expect(body.error).toMatch(/is not the origin/i);

      // Channel is still present.
      const row = await prisma.channel.findUnique({
        where: { id: fx.mirrorChannelId },
      });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('unknown mirror server → 404 unknown_mirror_server', async () => {
    const fx = await makeMirrorFixture();
    const envelope = buildChannelDeleteEnvelope({
      fx,
      serverId: ulid(),
      channelId: fx.mirrorChannelId,
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
      expect(body.error).toMatch(/mirror server .* not found/i);
    } finally {
      await app.close();
    }
  });

  it('deleting the LAST channel does NOT tear down the mirror Server', async () => {
    // The seed fixture has exactly one channel; delete it and confirm the
    // mirror Server (and its owner + everyone role) survives. This is the
    // explicit P4-8 invariant: mirror server with zero channels is still
    // valid — teardown is gated on LOCAL members emptying out, not on the
    // channel list.
    const fx = await makeMirrorFixture();
    const envelope = buildChannelDeleteEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      channelId: fx.mirrorChannelId,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      // Channel is gone.
      const ch = await prisma.channel.findUnique({
        where: { id: fx.mirrorChannelId },
      });
      expect(ch).toBeNull();

      // Mirror Server still present (with originInstanceId still set).
      const srv = await prisma.server.findUnique({
        where: { id: fx.mirrorServerId },
      });
      expect(srv).not.toBeNull();
      expect(srv!.originInstanceId).toBe(fx.peerInstanceId);

      // No channels remain on the mirror.
      const remaining = await prisma.channel.count({
        where: { serverId: fx.mirrorServerId },
      });
      expect(remaining).toBe(0);

      // The owner ServerMember is still attached — teardown didn't run.
      const owner = await prisma.serverMember.findUnique({
        where: {
          serverId_userId: {
            serverId: fx.mirrorServerId,
            userId: fx.localUserId,
          },
        },
      });
      expect(owner).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// P4-11 — inbound member.add + member.remove (mirror membership updates)
// ============================================================================

/**
 * For these handlers THIS instance is the B side — we hold a MIRROR of a
 * Server owned by the peer A. The peer pushes envelopes that announce
 * membership changes on T:
 *   - `member.add`: a new remote user joined T on A's side; we materialise
 *     a synthetic local User row + ServerMember on the mirror.
 *   - `member.remove`: a remote user was removed from T on A's side; we
 *     drop the ServerMember row (User row stays — see federation-mirror
 *     rationale).
 *
 * Setup reuses `makeMirrorFixture` from the P4-8 block — that gives us a
 * mirror Server owned by Alice@b.example with one existing channel. The
 * "new member" in member.add tests is a SECOND remote user on peer A
 * (Bob@b.example), seeded via `seedSecondPeerMemberFixture` below.
 */

/**
 * Seed a second remote user on the SAME peer that owns the mirror. Used
 * as the subject of `member.add` and `member.remove` envelopes. The
 * mirror's owner (Alice) is still the envelope signer — Bob is what's
 * being added or removed, not who is sending.
 *
 * Returns the qualified id + the synthetic local User id (NOT pre-
 * inserted — `addMirrorMember` is responsible for materialising it).
 * The RemoteUser cache row IS pre-inserted so the handler doesn't need
 * a profile fetch.
 */
async function seedMirrorSubjectMember(fx: MirrorFixture): Promise<{
  remoteUserId: string;
  remoteUserRowId: string;
  /** Optional: pre-insert the synthetic User + ServerMember (for member.remove tests). */
  preInsertLocal: () => Promise<string>;
}> {
  const kp = generateKeyPair();
  const remoteUserRowId = ulid();
  const localpart = `bob-${remoteUserRowId.slice(-6).toLowerCase()}`;
  const qualifiedId = `${localpart}@${PEER_HOST}`;
  await prisma.remoteUser.create({
    data: {
      id: remoteUserRowId,
      remoteInstanceId: fx.peerInstanceId,
      remoteUserId: qualifiedId,
      displayNameCache: 'Bob from B',
      avatarUrlCache: null,
      publicKey: exportPublicKeyRaw(kp.publicKey),
      lastSeenAt: new Date(0),
    },
  });
  return {
    remoteUserId: qualifiedId,
    remoteUserRowId,
    preInsertLocal: async () => {
      const localId = ulid();
      const syntheticUsername = `__rem_${ulid().toLowerCase()}`;
      await prisma.user.create({
        data: {
          id: localId,
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
      await prisma.serverMember.create({
        data: { serverId: fx.mirrorServerId, userId: localId },
      });
      return localId;
    },
  };
}

function buildMemberAddEnvelope(
  input: BuildMirrorEnvelopeBase & {
    serverId: string;
    memberRemoteUserId: string;
    memberDisplayName?: string;
    joinedAt?: string;
  },
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'member.add',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      serverId: input.serverId,
      memberRemoteUserId: input.memberRemoteUserId,
      memberDisplayName: input.memberDisplayName ?? 'Bob from B',
      joinedAt: input.joinedAt ?? new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

function buildMemberRemoveEnvelope(
  input: BuildMirrorEnvelopeBase & {
    serverId: string;
    memberRemoteUserId: string;
    reason?: 'kicked' | 'banned' | 'left';
    removedAt?: string;
  },
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'member.remove',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      serverId: input.serverId,
      memberRemoteUserId: input.memberRemoteUserId,
      reason: input.reason ?? 'kicked',
      removedAt: input.removedAt ?? new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

describe.skipIf(!dockerOk)('P4-11 — POST /_federation/event (member.add)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: materialises mirror member + broadcasts MEMBER_ADD', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);

    // Confirm baseline: mirror has exactly one ServerMember (Alice, the owner).
    const before = await prisma.serverMember.count({
      where: { serverId: fx.mirrorServerId },
    });
    expect(before).toBe(1);

    const envelope = buildMemberAddEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      memberRemoteUserId: subject.remoteUserId,
      memberDisplayName: 'Bob from B',
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
      expect(body.data?.serverId).toBe(fx.mirrorServerId);
      expect(typeof body.data?.userId).toBe('string');

      // Mirror now has two members.
      const members = await prisma.serverMember.findMany({
        where: { serverId: fx.mirrorServerId },
        include: { user: { select: { remoteUserId: true } } },
      });
      expect(members).toHaveLength(2);
      const remoteIds = members.map((m) => m.user.remoteUserId).sort();
      expect(remoteIds).toContain(subject.remoteUserId);

      // Envelope log row recorded.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'member.add' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      await app.close();
    }
  });

  it('idempotent: same envelope payload (different nonce) → ServerMember created once', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      // Two envelopes with the same payload — distinct nonces because
      // buildTwoLayerMessageEnvelope generates a fresh one per call. The
      // FIRST adds the member; the SECOND must short-circuit at the
      // mirror-helper P2002 catch and NOT raise.
      const first = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: buildMemberAddEnvelope({
          fx,
          serverId: fx.mirrorServerId,
          memberRemoteUserId: subject.remoteUserId,
        }),
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: buildMemberAddEnvelope({
          fx,
          serverId: fx.mirrorServerId,
          memberRemoteUserId: subject.remoteUserId,
        }),
      });
      expect(second.statusCode).toBe(200);
      const body = second.json();
      expect(body.ok).toBe(true);

      // Still exactly one new member on the mirror (plus the owner = 2 total).
      const count = await prisma.serverMember.count({
        where: { serverId: fx.mirrorServerId },
      });
      expect(count).toBe(2);

      // Two envelope log entries (one per nonce) — both accepted.
      const logs = await prisma.federationEnvelopeLog.findMany({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'member.add' },
      });
      expect(logs).toHaveLength(2);
      for (const l of logs) expect(l.status).toBe('accepted');
    } finally {
      await app.close();
    }
  });

  it('non-origin peer → 403 not_origin', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);
    const other = await seedSecondPeer();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'member.add',
      fromInstance: other.peerHost,
      toInstance: SELF_HOST,
      payload: {
        serverId: fx.mirrorServerId,
        memberRemoteUserId: subject.remoteUserId,
        memberDisplayName: 'hijacked',
        joinedAt: new Date().toISOString(),
      },
      signUser: (b: Buffer) => edSign(b, other.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, other.peerKp.privateKey),
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
      expect(body.error).toMatch(/is not the origin/i);

      // Mirror still has only the owner.
      const count = await prisma.serverMember.count({
        where: { serverId: fx.mirrorServerId },
      });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('unknown mirror server → 404 unknown_mirror_server', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);
    const envelope = buildMemberAddEnvelope({
      fx,
      serverId: ulid(), // no mirror with this id
      memberRemoteUserId: subject.remoteUserId,
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
      expect(body.error).toMatch(/mirror server .* not found/i);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P4-11 — POST /_federation/event (member.remove)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: drops mirror ServerMember + broadcasts MEMBER_REMOVE', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);
    const subjectLocalId = await subject.preInsertLocal();

    // Baseline: mirror has owner + Bob.
    const before = await prisma.serverMember.count({
      where: { serverId: fx.mirrorServerId },
    });
    expect(before).toBe(2);

    const envelope = buildMemberRemoveEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      memberRemoteUserId: subject.remoteUserId,
      reason: 'kicked',
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
      expect(body.data?.serverId).toBe(fx.mirrorServerId);
      expect(body.data?.userId).toBe(subjectLocalId);

      // Bob's ServerMember row is gone; owner remains.
      const remaining = await prisma.serverMember.findMany({
        where: { serverId: fx.mirrorServerId },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.userId).toBe(fx.localUserId);

      // Synthetic User row is intentionally PRESERVED (see federation-mirror
      // teardown rationale — orphan synthetic Users are cheap + preserve
      // idempotency on re-add).
      const orphanUser = await prisma.user.findUnique({
        where: { id: subjectLocalId },
      });
      expect(orphanUser).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('removing the last remote member does NOT tear down the mirror Server', async () => {
    // Setup: only the owner (Alice, who is also remote — synthesised in
    // makeFixture as a mirror user with `remoteUserId` set) plus Bob.
    // Removing Bob leaves Alice — the OWNER, who is the local user
    // representing the federation joiner from B's perspective. The mirror
    // must survive.
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);
    await subject.preInsertLocal();

    const envelope = buildMemberRemoveEnvelope({
      fx,
      serverId: fx.mirrorServerId,
      memberRemoteUserId: subject.remoteUserId,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      // The mirror Server is STILL present (with originInstanceId set).
      const server = await prisma.server.findUnique({
        where: { id: fx.mirrorServerId },
      });
      expect(server).not.toBeNull();
      expect(server!.originInstanceId).toBe(fx.peerInstanceId);

      // The owner ServerMember row is intact.
      const owner = await prisma.serverMember.findUnique({
        where: {
          serverId_userId: {
            serverId: fx.mirrorServerId,
            userId: fx.localUserId,
          },
        },
      });
      expect(owner).not.toBeNull();

      // Mirror channel is intact.
      const ch = await prisma.channel.findUnique({
        where: { id: fx.mirrorChannelId },
      });
      expect(ch).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('non-origin peer → 403 not_origin', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);
    await subject.preInsertLocal();
    const other = await seedSecondPeer();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'member.remove',
      fromInstance: other.peerHost,
      toInstance: SELF_HOST,
      payload: {
        serverId: fx.mirrorServerId,
        memberRemoteUserId: subject.remoteUserId,
        reason: 'kicked',
        removedAt: new Date().toISOString(),
      },
      signUser: (b: Buffer) => edSign(b, other.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, other.peerKp.privateKey),
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
      expect(body.error).toMatch(/is not the origin/i);

      // Bob's ServerMember row is STILL present.
      const count = await prisma.serverMember.count({
        where: { serverId: fx.mirrorServerId },
      });
      expect(count).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('unknown mirror server → 404 unknown_mirror_server', async () => {
    const fx = await makeMirrorFixture();
    const subject = await seedMirrorSubjectMember(fx);
    await subject.preInsertLocal();
    const envelope = buildMemberRemoveEnvelope({
      fx,
      serverId: ulid(),
      memberRemoteUserId: subject.remoteUserId,
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
      expect(body.error).toMatch(/mirror server .* not found/i);
    } finally {
      await app.close();
    }
  });
});

// ============================================================================
// P4-12 — inbound member.leave (voluntary leave from a remote user)
// ============================================================================

/**
 * For this handler THIS instance is the A side — we OWN the Tavern, and
 * a peer (B) tells us one of their users wants to leave. The handler:
 *   - cross-checks the verified signer matches the leaver in the payload,
 *   - drops the ServerMember row (idempotent if already gone),
 *   - returns a single-layer signed `member.removed` ack envelope,
 *   - fans out `member.remove` (reason='left') to peers OTHER than B,
 *   - broadcasts `MEMBER_REMOVE` locally.
 *
 * The base `makeFixture` already gives us exactly the setup we need: a
 * LOCAL Server with a remote ServerMember (Alice from B). The leave
 * envelope is signed by Alice's user key and B's instance key.
 */

function buildMemberLeaveEnvelope(input: {
  fx: PeerFixture;
  serverId: string;
  leaverRemoteUserId?: string;
  leftAt?: string;
  fromInstance?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'member.leave',
    fromInstance: input.fromInstance ?? PEER_HOST,
    toInstance: SELF_HOST,
    payload: {
      serverId: input.serverId,
      leaverRemoteUserId: input.leaverRemoteUserId ?? fx.authorRemoteUserId,
      leftAt: input.leftAt ?? new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.authorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

/**
 * Assert that the response body parses as a single-layer signed
 * `member.removed` envelope, signed by this instance's federation key.
 * Returns the typed payload for further assertions.
 */
async function assertSignedRemovedReply(body: unknown): Promise<{
  serverId: string;
  leaverRemoteUserId: string;
}> {
  expect(body).toMatchObject({
    version: PROTOCOL_VERSION,
    eventType: 'member.removed',
    fromInstance: SELF_HOST,
    toInstance: PEER_HOST,
  });

  const env = body as {
    payload: { serverId: string; leaverRemoteUserId: string };
    signature: string;
    version: string;
    eventType: string;
    nonce: string;
    notBefore: string;
    notAfter: string;
    fromInstance: string;
    toInstance: string;
  };

  const keyRow = await prisma.federationKey.findFirstOrThrow({
    where: { isCurrent: true },
  });
  const pub = publicKeyFromRaw(Buffer.from(keyRow.publicKey));
  const { signature, ...unsigned } = env;
  const bytes = Buffer.from(canonicalize(unsigned as unknown), 'utf8');
  expect(edVerify(bytes, Buffer.from(signature, 'base64'), pub)).toBe(true);

  return env.payload;
}

describe.skipIf(!dockerOk)('P4-12 — POST /_federation/event (member.leave)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  // ─── 1. Happy path: drops member + signed ack + local broadcast ──────────

  it('happy path: deletes ServerMember + returns signed member.removed ack', async () => {
    const fx = await makeFixture();

    // Baseline: the fixture's ServerMember (Alice from B) is present.
    const before = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
    });
    expect(before).not.toBeNull();

    const envelope = buildMemberLeaveEnvelope({ fx, serverId: fx.serverId });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const events: Array<{ type: string; userId?: string; serverId?: string; data: unknown }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      const replyPayload = await assertSignedRemovedReply(res.json());
      expect(replyPayload.serverId).toBe(fx.serverId);
      expect(replyPayload.leaverRemoteUserId).toBe(fx.authorRemoteUserId);

      // ServerMember row is gone.
      const after = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
      });
      expect(after).toBeNull();

      // The synthetic User row is intentionally preserved (see federation-
      // mirror.ts teardown rationale).
      const userStill = await prisma.user.findUnique({
        where: { id: fx.localUserId },
      });
      expect(userStill).not.toBeNull();

      // MEMBER_REMOVE broadcast scoped to the server.
      const memberRemoves = events.filter((e) => e.type === 'MEMBER_REMOVE');
      expect(memberRemoves).toHaveLength(1);
      expect(memberRemoves[0]!.serverId).toBe(fx.serverId);
      expect((memberRemoves[0]!.data as { userId: string }).userId).toBe(
        fx.localUserId,
      );

      // Envelope log row recorded.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'member.leave' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  // ─── 2. Mismatched leaver: payload claims a user different from the signer ──

  it('rejects with 401 when payload.leaverRemoteUserId differs from the signing user', async () => {
    const fx = await makeFixture();
    // Seed Bob — a SECOND remote user on the same peer — with his own
    // public key cached. The envelope below names Bob as the leaver in
    // the payload but is SIGNED with Alice's user key. The dispatcher
    // pulls Bob's public key from the cache and tries to verify Alice's
    // signature against it; the user-layer signature fails verification,
    // raising bad_signature (401). The handler's `unauthorized_leave`
    // check covers the harder case where verification passed but the
    // payload's leaver still names someone else; both paths surface as
    // 401 to the peer, which is what we assert here.
    const bob = await seedSecondRemoteUser(fx);

    const envelope = buildMemberLeaveEnvelope({
      fx,
      serverId: fx.serverId,
      leaverRemoteUserId: bob.remoteUserId,
      // signUser is the default Alice key — the cross-check between
      // signer and payload leaver fires either at the crypto layer
      // (when Bob's cached key differs) or at the handler's
      // unauthorized_leave guard (when they happen to match).
    });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(401);

      // ServerMember row is still present — handler bailed before delete.
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
      });
      expect(member).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ─── 3. Unknown user (no local User row for the leaver) ──────────────────

  it('returns 404 unknown_member when the leaver has no local User row', async () => {
    const fx = await makeFixture();

    // Drop the synthetic local User mirror of Alice. The RemoteUser cache
    // row remains (so the dispatcher can still resolve Alice's public key
    // for signature verification), but the User row keyed on
    // `remoteUserId = Alice` no longer exists.
    await prisma.serverMember.deleteMany({ where: { userId: fx.localUserId } });
    await prisma.user.delete({ where: { id: fx.localUserId } });

    const envelope = buildMemberLeaveEnvelope({ fx, serverId: fx.serverId });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/no local User row/i);
    } finally {
      await app.close();
    }
  });

  // ─── 4. Idempotent: leave a non-member → 200 + signed ack anyway ────────

  it('returns a signed ack even when the ServerMember row is already gone', async () => {
    const fx = await makeFixture();
    // Pre-delete Alice's ServerMember row — a retried leave envelope
    // should still settle cleanly with the ack.
    await prisma.serverMember.delete({
      where: { serverId_userId: { serverId: fx.serverId, userId: fx.localUserId } },
    });

    const envelope = buildMemberLeaveEnvelope({ fx, serverId: fx.serverId });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const events: Array<{ type: string }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      // Ack body is signed.
      const replyPayload = await assertSignedRemovedReply(res.json());
      expect(replyPayload.serverId).toBe(fx.serverId);
      expect(replyPayload.leaverRemoteUserId).toBe(fx.authorRemoteUserId);

      // No MEMBER_REMOVE broadcast fired (nothing to remove).
      const memberRemoves = events.filter((e) => e.type === 'MEMBER_REMOVE');
      expect(memberRemoves).toHaveLength(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  // ─── 5. Fan-out: member.remove to OTHER peers, exclude leaver's home ────

  it('fans out member.remove (reason=left) to OTHER peers, excluding the leaver home', async () => {
    const fx = await makeFixture();
    // Seed a second peer (C) with its own remote member of T so the
    // fan-out has a non-empty audience after Alice's delete. Without
    // another peer in T, fanOutMemberRemove returns early with no
    // enqueues, and we can't distinguish "correctly skipped" from
    // "wrong gate".
    const otherPeer = await seedSecondPeer();
    const otherLocalUserId = ulid();
    const otherLocalpart = `eve-${otherLocalUserId.slice(-6).toLowerCase()}`;
    const otherRemoteUserId = `${otherLocalpart}@${otherPeer.peerHost}`;
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: otherPeer.peerInstanceId,
        remoteUserId: otherRemoteUserId,
        displayNameCache: 'Eve',
        avatarUrlCache: null,
        publicKey: randomBytes(32),
      },
    });
    await prisma.user.create({
      data: {
        id: otherLocalUserId,
        username: `__rem_${otherLocalUserId.toLowerCase()}`,
        usernameLower: `__rem_${otherLocalUserId.toLowerCase()}`,
        displayName: 'Eve',
        email: `${otherRemoteUserId}.federated.local`,
        emailLower: `${otherRemoteUserId}.federated.local`,
        passwordHash: null,
        remoteUserId: otherRemoteUserId,
        remoteInstanceId: otherPeer.peerInstanceId,
      },
    });
    await prisma.serverMember.create({
      data: { serverId: fx.serverId, userId: otherLocalUserId },
    });

    const envelope = buildMemberLeaveEnvelope({ fx, serverId: fx.serverId });

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
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      // Exactly one enqueue — for the OTHER peer (C). The leaver's home
      // (B / fx.peerInstanceId) is excluded because they received the
      // synchronous `member.removed` ack as the HTTP response.
      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('member.remove');
      expect(job.peerInstanceId).toBe(otherPeer.peerInstanceId);
      expect(job.peerInstanceId).not.toBe(fx.peerInstanceId);
      // Payload is the leave-flavoured remove (reason='left'); the actor
      // is the leaver, not a moderator.
      const payload = job.payload as {
        serverId: string;
        memberRemoteUserId: string;
        reason: string;
      };
      expect(payload.serverId).toBe(fx.serverId);
      expect(payload.memberRemoteUserId).toBe(fx.authorRemoteUserId);
      expect(payload.reason).toBe('left');
    } finally {
      await app.close();
    }
  });
});

/**
 * P4-13 — Home-instance message relay.
 *
 * When this instance is the HOME of a federated server T and receives a
 * `message.create` envelope from one of T's peers, it MUST forward the
 * message to every OTHER peer that has a member in T — with the original
 * author's user signature PRESERVED (not re-signed; we don't hold the
 * remote author's private key) and the outer envelope signed by THIS
 * instance.
 *
 * Coverage matrix:
 *   1. Happy path: A (this instance, home of T) receives a message from B;
 *      C is another peer in T → one relay envelope enqueued to C, original
 *      user sig preserved, `fromInstance = selfHost`, target = C's host.
 *   2. No relay when the receiving peer is the only peer in T (nobody else
 *      to forward to).
 *   3. No relay when THIS instance is a mirror of T (originInstanceId is
 *      set). Mirrors do not relay — that would loop back to the home.
 *   4. Verifies the relay envelope structure on the wire — `userSignature`
 *      equals the inbound envelope's signature, the relayed payload still
 *      verifies against the original author's public key under the
 *      `verifyTwoLayerMessageEnvelope` helper.
 */
describe.skipIf(!dockerOk)('P4-13 — home-instance relay on inbound message.create', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('relays to OTHER peers when this instance is the home of T', async () => {
    // Default fixture: T is a LOCAL server (originInstanceId = null) on this
    // instance, with author alice@b.example as a remote member. This makes
    // THIS instance the home of T from the relay's perspective.
    const fx = await makeFixture();

    // Seed peer C with its own remote member in T so the relay has a
    // non-empty audience (excluding B, who is the originating peer).
    const peerC = await seedSecondPeer();
    const cLocalUserId = ulid();
    const cLocalpart = `charlie-${cLocalUserId.slice(-6).toLowerCase()}`;
    const cQualifiedId = `${cLocalpart}@${peerC.peerHost}`;
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: peerC.peerInstanceId,
        remoteUserId: cQualifiedId,
        displayNameCache: 'Charlie from C',
        avatarUrlCache: null,
        publicKey: randomBytes(32),
      },
    });
    await prisma.user.create({
      data: {
        id: cLocalUserId,
        username: `__rem_${cLocalUserId.toLowerCase()}`,
        usernameLower: `__rem_${cLocalUserId.toLowerCase()}`,
        displayName: 'Charlie from C',
        email: `${cQualifiedId}.federated.local`,
        emailLower: `${cQualifiedId}.federated.local`,
        passwordHash: null,
        remoteUserId: cQualifiedId,
        remoteInstanceId: peerC.peerInstanceId,
      },
    });
    await prisma.serverMember.create({
      data: { serverId: fx.serverId, userId: cLocalUserId },
    });

    const messageId = ulid();
    const envelope = buildMsgCreateEnvelope({ fx, messageId, content: 'hi everyone' });

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
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      // Exactly one relay enqueue — only peer C is in T's audience after
      // excluding the originating peer B. There may be no further calls
      // even if the test environment happened to seed extra membership.
      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = captured[0]!;
      expect(job.eventType).toBe('message.create');
      expect(job.messageId).toBe(messageId);
      expect(job.peerInstanceId).toBe(peerC.peerInstanceId);
      // Defence-in-depth: NEVER echo back to the originating peer.
      expect(job.peerInstanceId).not.toBe(fx.peerInstanceId);

      // The preserved user signature MUST be the byte-identical signature
      // off the inbound envelope. If anything has touched it the receiver
      // would 401 with `user signature does not verify`.
      expect(job.preservedUserSignature).toBe(envelope.userSignature);

      // The relayed payload must include the ORIGINAL author identifier
      // (alice@b.example), not a re-qualified id pointing at THIS instance.
      // The receiving peer verifies the user signature against alice's
      // known public key from her home (b.example).
      const payload = job.payload as { authorRemoteUserId: string; messageId: string; content: string };
      expect(payload.authorRemoteUserId).toBe(fx.authorRemoteUserId);
      expect(payload.messageId).toBe(messageId);
      expect(payload.content).toBe('hi everyone');
    } finally {
      await app.close();
    }
  });

  it('does NOT relay when the originating peer is the only peer in T', async () => {
    // No second peer seeded — B is the only one with a member in T.
    // After excluding B (the originator), the relay set is empty and the
    // helper short-circuits without enqueueing.
    const fx = await makeFixture();
    const envelope = buildMsgCreateEnvelope({ fx });

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
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT relay when this instance is a mirror of T (not the home)', async () => {
    // A mirror fixture sets `Server.originInstanceId = peerInstanceId` —
    // T's home is on the other side. If this instance also forwarded
    // inbound message.create envelopes, the relay would echo back to the
    // home and waste round trips (or worse, loop if guards regress).
    const fx = await makeMirrorFixture();
    // Seed a second peer with a member in the MIRROR server so we'd have
    // somebody to relay to IF the gate were broken — proves the gate is
    // what stops the enqueue, not an empty audience.
    const otherPeer = await seedSecondPeer();
    const otherLocalUserId = ulid();
    const otherLocalpart = `dora-${otherLocalUserId.slice(-6).toLowerCase()}`;
    const otherQualifiedId = `${otherLocalpart}@${otherPeer.peerHost}`;
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: otherPeer.peerInstanceId,
        remoteUserId: otherQualifiedId,
        displayNameCache: 'Dora',
        avatarUrlCache: null,
        publicKey: randomBytes(32),
      },
    });
    await prisma.user.create({
      data: {
        id: otherLocalUserId,
        username: `__rem_${otherLocalUserId.toLowerCase()}`,
        usernameLower: `__rem_${otherLocalUserId.toLowerCase()}`,
        displayName: 'Dora',
        email: `${otherQualifiedId}.federated.local`,
        emailLower: `${otherQualifiedId}.federated.local`,
        passwordHash: null,
        remoteUserId: otherQualifiedId,
        remoteInstanceId: otherPeer.peerInstanceId,
      },
    });
    await prisma.serverMember.create({
      data: { serverId: fx.mirrorServerId, userId: otherLocalUserId },
    });

    // Build a message.create envelope targeting the MIRROR channel. The
    // inbound handler accepts it (mirror channel + federation on) but
    // the relay gate sees originInstanceId != null and skips the fan-out.
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'message.create',
      fromInstance: PEER_HOST,
      toInstance: SELF_HOST,
      payload: {
        authorRemoteUserId: fx.authorRemoteUserId,
        channelId: fx.mirrorChannelId,
        messageId: ulid(),
        content: 'should not be relayed by a mirror',
        replyToMessageId: null,
        createdAt: new Date().toISOString(),
      },
      signUser: (b: Buffer) => edSign(b, fx.authorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, fx.peerKp.privateKey),
    });

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
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      // No relay — mirrors don't forward; the originating peer (the home)
      // is responsible for fanning out to every other peer directly.
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('relay envelope verifies on the receiving peer: original user sig + this-instance sig', async () => {
    // End-to-end signature check: take the captured relay job, build the
    // would-be wire envelope the dispatcher would produce, and verify it
    // with the original author key (alice@b) + a stand-in instance key for
    // THIS instance. The dispatcher signs with `deps.federationKeys`; in
    // this test we substitute a known keypair and verify against its public
    // half. Proves: the receiver's verifier accepts both layers when fed
    // the relayed payload + preserved user sig.
    const fx = await makeFixture();
    const peerC = await seedSecondPeer();
    const cLocalUserId = ulid();
    const cLocalpart = `eve-${cLocalUserId.slice(-6).toLowerCase()}`;
    const cQualifiedId = `${cLocalpart}@${peerC.peerHost}`;
    await prisma.remoteUser.create({
      data: {
        id: ulid(),
        remoteInstanceId: peerC.peerInstanceId,
        remoteUserId: cQualifiedId,
        displayNameCache: 'Eve from C',
        avatarUrlCache: null,
        publicKey: randomBytes(32),
      },
    });
    await prisma.user.create({
      data: {
        id: cLocalUserId,
        username: `__rem_${cLocalUserId.toLowerCase()}`,
        usernameLower: `__rem_${cLocalUserId.toLowerCase()}`,
        displayName: 'Eve from C',
        email: `${cQualifiedId}.federated.local`,
        emailLower: `${cQualifiedId}.federated.local`,
        passwordHash: null,
        remoteUserId: cQualifiedId,
        remoteInstanceId: peerC.peerInstanceId,
      },
    });
    await prisma.serverMember.create({
      data: { serverId: fx.serverId, userId: cLocalUserId },
    });

    const inboundEnv = buildMsgCreateEnvelope({ fx, messageId: ulid(), content: 'verifiable relay' });
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
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: inboundEnv,
      });
      expect(res.statusCode).toBe(200);
      expect(captured.length).toBe(1);
      const job = captured[0]!;

      // Reconstruct what the dispatcher would put on the wire: same payload,
      // preserved user signature, instance signature from THIS instance.
      const thisInstanceKp = generateKeyPair();
      const wireEnvelope = buildTwoLayerMessageEnvelope({
        eventType: job.eventType,
        fromInstance: SELF_HOST,
        toInstance: peerC.peerHost,
        payload: job.payload,
        preservedUserSignature: job.preservedUserSignature!,
        signInstance: (b: Buffer) => edSign(b, thisInstanceKp.privateKey),
      });

      // The receiving peer C would verify with:
      //   - peer instance key = this instance's published key (the relay
      //     envelope's `fromInstance = SELF_HOST`, so the verifier looks up
      //     OUR RemoteInstance row on its side)
      //   - author public key = alice@b's public key, looked up via
      //     RemoteUser cache (or fetched from b.example's well-known)
      // We can simulate both by passing the raw keys directly.
      const userPubRaw = exportPublicKeyRaw(fx.authorKp.publicKey);
      const instancePubRaw = exportPublicKeyRaw(thisInstanceKp.publicKey);

      const verifyResult = verifyTwoLayerMessageEnvelope({
        envelope: wireEnvelope,
        peerInstancePublicKeyRaw: Buffer.from(instancePubRaw),
        authorPublicKeyRaw: Buffer.from(userPubRaw),
        payloadSchema: messageCreatePayloadSchema,
      });
      expect(verifyResult.ok).toBe(true);
      if (verifyResult.ok) {
        // Author identity on the wire is still alice — the relay does NOT
        // rewrite the author to look like the relay-er.
        expect(verifyResult.payload.authorRemoteUserId).toBe(fx.authorRemoteUserId);
      }

      // Belt-and-braces: a tampered payload (anything that changes the
      // canonical bytes) must fail user-signature verification, proving
      // the preserved signature is genuinely the original author's sig
      // and not silently re-derived.
      const tampered = {
        ...wireEnvelope,
        payload: { ...(wireEnvelope.payload as object), content: 'evil edit' },
      };
      const tamperResult = verifyTwoLayerMessageEnvelope({
        envelope: tampered,
        peerInstancePublicKeyRaw: Buffer.from(instancePubRaw),
        authorPublicKeyRaw: Buffer.from(userPubRaw),
        payloadSchema: messageCreatePayloadSchema,
      });
      expect(tamperResult.ok).toBe(false);
      if (!tamperResult.ok) {
        // Either layer can complain depending on whether the canonical-
        // signed surface changed — for a payload edit the user-sig
        // verification fails because the canonical bytes change.
        expect(tamperResult.reason).toMatch(/user signature|instance signature/i);
      }
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5-4 — POST /_federation/event (dm.create)
// ─────────────────────────────────────────────────────────────────────────────
//
// Coverage matrix:
//   1. Happy path: peer advertises `dms`, recipient localpart maps to a
//      local user → DmChannel created with both members, DM_CHANNEL_CREATE
//      broadcast targeted at the recipient.
//   2. Idempotent re-delivery: second envelope with a different nonce but
//      the same dmChannelId → 200 deduplicated, still exactly one
//      DmChannel row.
//   3. Peer lacks the `dms` capability → 403 `dms_capability_missing`.
//   4. Recipient localpart doesn't match any local user → 404 `unknown_recipient`.
//   5. Recipient host doesn't match selfHost → 404 `unknown_recipient`.
//   6. Same pairKey already maps to a DIFFERENT DmChannel id → 409
//      `dm_channel_conflict`.
//   7. Same dmChannelId already exists but represents a DIFFERENT pair →
//      409 `dm_channel_conflict`.

interface DmPeerFixture {
  peerInstanceId: string;
  peerHost: string;
  peerKp: ReturnType<typeof generateKeyPair>;
  /** The remote initiator on the peer instance. */
  initiatorKp: ReturnType<typeof generateKeyPair>;
  initiatorRemoteUserId: string;
  /** Local recipient on this instance. */
  recipientUserId: string;
  recipientUsername: string;
}

async function makeDmFixture(opts?: {
  capabilities?: string[];
  /** Override the recipient username so we can simulate a different localpart. */
  recipientUsername?: string;
}): Promise<DmPeerFixture> {
  const peerHost = 'dm-peer.example';
  const peerKp = generateKeyPair();
  const initiatorKp = generateKeyPair();
  const peerInstanceId = ulid();
  const initiatorLocalpart = `bob-${peerInstanceId.slice(-6).toLowerCase()}`;
  const initiatorRemoteUserId = `${initiatorLocalpart}@${peerHost}`;

  await prisma.remoteInstance.create({
    data: {
      id: peerInstanceId,
      host: peerHost,
      instanceKey: exportPublicKeyRaw(peerKp.publicKey),
      status: 'peered',
      capabilities: opts?.capabilities ?? ['messages', 'dms'],
      peeredAt: new Date(),
    },
  });

  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: peerInstanceId,
      remoteUserId: initiatorRemoteUserId,
      displayNameCache: 'Bob from peer',
      avatarUrlCache: null,
      publicKey: exportPublicKeyRaw(initiatorKp.publicKey),
      lastSeenAt: new Date(0),
    },
  });

  // Local recipient — alice@self.example. Username MUST be lower-case so
  // the handler's `usernameLower` lookup matches without further folding
  // (Tavern's signup path lowercases ahead of insert; the test fixture
  // mirrors that invariant).
  const recipientUserId = ulid();
  const recipientUsername =
    opts?.recipientUsername ?? `alice-${recipientUserId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: recipientUserId,
      username: recipientUsername,
      usernameLower: recipientUsername,
      displayName: 'Alice (local)',
      email: `${recipientUsername}@${SELF_HOST}`,
      emailLower: `${recipientUsername}@${SELF_HOST}`,
      passwordHash: 'x',
    },
  });

  return {
    peerInstanceId,
    peerHost,
    peerKp,
    initiatorKp,
    initiatorRemoteUserId,
    recipientUserId,
    recipientUsername,
  };
}

interface BuildDmCreateEnvelopeInput {
  fx: DmPeerFixture;
  dmChannelId?: string;
  /** Override the initiator id placed in the payload (for spoof / signature-mismatch tests). */
  initiatorRemoteUserIdOverride?: string;
  /** Override the recipient id (for unknown-recipient + wrong-host tests). */
  recipientRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildDmCreateEnvelope(
  input: BuildDmCreateEnvelopeInput,
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'dm.create',
    fromInstance: fx.peerHost,
    toInstance: SELF_HOST,
    payload: {
      dmChannelId: input.dmChannelId ?? ulid(),
      initiatorRemoteUserId:
        input.initiatorRemoteUserIdOverride ?? fx.initiatorRemoteUserId,
      recipientRemoteUserId:
        input.recipientRemoteUserIdOverride ??
        `${fx.recipientUsername}@${SELF_HOST}`,
      createdAt: new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.initiatorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

describe.skipIf(!dockerOk)('P5-4 — POST /_federation/event (dm.create)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: persists DmChannel + both members and broadcasts DM_CHANNEL_CREATE to the recipient', async () => {
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const dmChannelId = ulid();
    const envelope = buildDmCreateEnvelope({ fx, dmChannelId });

    const events: Array<{
      type: string;
      userId?: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data?.dmChannelId).toBe(dmChannelId);
      expect(body.data?.deduplicated).toBe(false);

      // DmChannel row + both members present.
      const channel = await prisma.dmChannel.findUnique({
        where: { id: dmChannelId },
        include: { members: { select: { userId: true } } },
      });
      expect(channel).not.toBeNull();
      expect(channel!.kind).toBe('direct');
      expect(channel!.pairKey).not.toBeNull();

      // Initiator's synthetic local User must have been materialised.
      const initiatorLocal = await prisma.user.findUnique({
        where: { remoteUserId: fx.initiatorRemoteUserId },
        select: { id: true },
      });
      expect(initiatorLocal).not.toBeNull();

      const memberIds = channel!.members.map((m) => m.userId).sort();
      const expectedIds = [fx.recipientUserId, initiatorLocal!.id].sort();
      expect(memberIds).toEqual(expectedIds);

      // pairKey is the sorted qualified-id pair.
      const expectedPairKey =
        fx.initiatorRemoteUserId < `${fx.recipientUsername}@${SELF_HOST}`
          ? `${fx.initiatorRemoteUserId}:${fx.recipientUsername}@${SELF_HOST}`
          : `${fx.recipientUsername}@${SELF_HOST}:${fx.initiatorRemoteUserId}`;
      expect(channel!.pairKey).toBe(expectedPairKey);

      // Gateway broadcast targeted at the recipient.
      const dmCreates = events.filter((e) => e.type === 'DM_CHANNEL_CREATE');
      expect(dmCreates).toHaveLength(1);
      expect(dmCreates[0]!.dmChannelId).toBe(dmChannelId);
      expect(dmCreates[0]!.userId).toBe(fx.recipientUserId);

      // Envelope log + lastSeenAt updated.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'dm.create' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');

      const ru = await prisma.remoteUser.findUnique({
        where: { remoteUserId: fx.initiatorRemoteUserId },
      });
      expect(ru!.lastSeenAt.getTime()).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('idempotent re-delivery: same dmChannelId with a fresh nonce → 200 deduplicated, still one row', async () => {
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const dmChannelId = ulid();

    try {
      // First delivery — normal happy path.
      const first = buildDmCreateEnvelope({ fx, dmChannelId });
      const res1 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: first,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().data?.deduplicated).toBe(false);

      // Second delivery — same payload contents (incl. same dmChannelId)
      // but a NEW nonce so the envelope-log replay protection doesn't
      // catch it. The handler-level idempotency MUST kick in.
      const second = buildDmCreateEnvelope({ fx, dmChannelId });
      // `buildTwoLayerMessageEnvelope` generates a fresh ULID nonce each
      // call; sanity-check.
      expect((second as { nonce: string }).nonce).not.toBe(
        (first as { nonce: string }).nonce,
      );
      const res2 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: second,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().data?.deduplicated).toBe(true);
      expect(res2.json().data?.dmChannelId).toBe(dmChannelId);

      // Only one DmChannel row across both deliveries.
      const channels = await prisma.dmChannel.findMany({ where: { id: dmChannelId } });
      expect(channels).toHaveLength(1);
      const allMembers = await prisma.dmChannelMember.findMany({
        where: { dmChannelId },
      });
      expect(allMembers).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('rejects with 403 when the peer does not advertise the `dms` capability', async () => {
    // Peer is peered for `messages` only — DM federation is opt-in.
    const fx = await makeDmFixture({ capabilities: ['messages'] });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildDmCreateEnvelope({ fx });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/dms.*capability/i);

      // No DmChannel created.
      const count = await prisma.dmChannel.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects with 404 when the recipient localpart does not match a local user', async () => {
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    // Recipient localpart that nobody has signed up under.
    const envelope = buildDmCreateEnvelope({
      fx,
      recipientRemoteUserIdOverride: `nobody-${ulid().toLowerCase()}@${SELF_HOST}`,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toMatch(/no local user matches/i);

      const count = await prisma.dmChannel.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects with 404 when the recipient @host does not match selfHost', async () => {
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    // Right localpart, WRONG host — the peer is targeting a different
    // instance. Should NOT match anything local.
    const envelope = buildDmCreateEnvelope({
      fx,
      recipientRemoteUserIdOverride: `${fx.recipientUsername}@wrong.example`,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toMatch(/does not match this instance/i);

      const count = await prisma.dmChannel.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects with 409 when an existing DmChannel for this pair has a different id', async () => {
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    // Pre-seed the initiator's local mirror User + a DmChannel with the
    // canonical pairKey but a DIFFERENT id than the envelope will carry.
    // That simulates the "we already opened this DM locally" case where
    // the peer doesn't know about our id yet.
    const initiatorRemoteUserRow = await prisma.remoteUser.findUnique({
      where: { remoteUserId: fx.initiatorRemoteUserId },
    });
    const initiatorLocalUserId = ulid();
    const initiatorSyntheticUsername = `__rem_${initiatorLocalUserId.toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: initiatorLocalUserId,
        username: initiatorSyntheticUsername,
        usernameLower: initiatorSyntheticUsername,
        displayName: 'Bob from peer',
        email: `${fx.initiatorRemoteUserId}.federated.local`,
        emailLower: `${fx.initiatorRemoteUserId}.federated.local`,
        passwordHash: null,
        remoteUserId: fx.initiatorRemoteUserId,
        remoteInstanceId: fx.peerInstanceId,
        federationKeyPublic: initiatorRemoteUserRow!.publicKey,
      },
    });
    const recipientQualifiedId = `${fx.recipientUsername}@${SELF_HOST}`;
    const expectedPairKey =
      fx.initiatorRemoteUserId < recipientQualifiedId
        ? `${fx.initiatorRemoteUserId}:${recipientQualifiedId}`
        : `${recipientQualifiedId}:${fx.initiatorRemoteUserId}`;
    const existingDmChannelId = ulid();
    await prisma.dmChannel.create({
      data: {
        id: existingDmChannelId,
        kind: 'direct',
        pairKey: expectedPairKey,
        createdById: fx.recipientUserId,
        members: {
          create: [
            { userId: fx.recipientUserId },
            { userId: initiatorLocalUserId },
          ],
        },
      },
    });

    // Now deliver a dm.create with a different id but the same pair.
    const proposedDmChannelId = ulid();
    expect(proposedDmChannelId).not.toBe(existingDmChannelId);
    const envelope = buildDmCreateEnvelope({
      fx,
      dmChannelId: proposedDmChannelId,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toMatch(/pairKey already maps to a different DmChannel/i);

      // Existing DmChannel untouched, no new row.
      const channels = await prisma.dmChannel.findMany({});
      expect(channels).toHaveLength(1);
      expect(channels[0]!.id).toBe(existingDmChannelId);
    } finally {
      await app.close();
    }
  });

  it('rejects with 409 when the proposed dmChannelId already exists for a different pair', async () => {
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    // Seed a DmChannel between two LOCAL users with the proposed id.
    // The pairKey will be the local-id form (no `@`), which is
    // guaranteed not to collide with the federated qualified-id pairKey
    // the envelope will compute.
    const otherLocalUserId = ulid();
    const otherLocalUsername = `dave-${otherLocalUserId.slice(-6).toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: otherLocalUserId,
        username: otherLocalUsername,
        usernameLower: otherLocalUsername,
        displayName: 'Dave (local)',
        email: `${otherLocalUsername}@${SELF_HOST}`,
        emailLower: `${otherLocalUsername}@${SELF_HOST}`,
        passwordHash: 'x',
      },
    });
    const proposedDmChannelId = ulid();
    const localPairKey =
      fx.recipientUserId < otherLocalUserId
        ? `${fx.recipientUserId}:${otherLocalUserId}`
        : `${otherLocalUserId}:${fx.recipientUserId}`;
    await prisma.dmChannel.create({
      data: {
        id: proposedDmChannelId,
        kind: 'direct',
        pairKey: localPairKey,
        createdById: fx.recipientUserId,
        members: {
          create: [
            { userId: fx.recipientUserId },
            { userId: otherLocalUserId },
          ],
        },
      },
    });

    // Envelope wants to claim the same dmChannelId for the federated pair.
    const envelope = buildDmCreateEnvelope({ fx, dmChannelId: proposedDmChannelId });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toMatch(/already exists for a different pair/i);

      // Existing DmChannel still keyed on the local pair, not overwritten.
      const channels = await prisma.dmChannel.findMany({});
      expect(channels).toHaveLength(1);
      expect(channels[0]!.id).toBe(proposedDmChannelId);
      expect(channels[0]!.pairKey).toBe(localPairKey);
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5-6 — POST /_federation/event (dm.message.create)
// ─────────────────────────────────────────────────────────────────────────────
//
// Coverage matrix:
//   1. Happy path: peer with `dms` capability sends dm.message.create into a
//      DmChannel that was previously federated via `dm.create`. Message row
//      lands with origin + signature; DM_MESSAGE_CREATE broadcast fires;
//      `lastMessageAt` advances to the payload's createdAt.
//   2. Unknown dmChannelId → 404 `unknown_dm_channel` (out-of-order delivery
//      before the recipient accepted the `dm.create`).
//   3. Author User row exists but is NOT a DmChannelMember → 403 `not_dm_member`.
//   4. Author User row doesn't exist locally at all → 404 `unknown_dm_member`.
//   5. Replay (same envelope nonce twice) → first 200, second 409.
//   6. Idempotent (same messageId, fresh nonce) → 200 dedup.
//   7. Peer lacks `dms` capability → 403 `dms_capability_missing`.

interface DmMessageFixture extends DmPeerFixture {
  /** DmChannel id pre-created via the dm.create handler path. */
  dmChannelId: string;
  /** Local mirror User.id materialised for the initiator (the author). */
  initiatorLocalUserId: string;
}

/**
 * Seed a peered RemoteInstance + initiator RemoteUser + local recipient,
 * then run a `dm.create` envelope through the public route so we exercise
 * the same code path that real federation would (rather than hand-crafting
 * DmChannel rows). Returns ids + keys the test needs.
 */
async function makeDmMessageFixture(opts?: {
  capabilities?: string[];
}): Promise<DmMessageFixture> {
  const fx = await makeDmFixture(opts);
  const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
  try {
    const dmChannelId = ulid();
    const envelope = buildDmCreateEnvelope({ fx, dmChannelId });
    const res = await app.inject({
      method: 'POST',
      url: '/_federation/event',
      payload: envelope,
    });
    if (res.statusCode !== 200) {
      throw new Error(
        `makeDmMessageFixture: dm.create returned ${res.statusCode}: ${res.body}`,
      );
    }
    const initiatorLocal = await prisma.user.findUnique({
      where: { remoteUserId: fx.initiatorRemoteUserId },
      select: { id: true },
    });
    if (!initiatorLocal) {
      throw new Error('makeDmMessageFixture: initiator local user not materialised');
    }
    return {
      ...fx,
      dmChannelId,
      initiatorLocalUserId: initiatorLocal.id,
    };
  } finally {
    await app.close();
  }
}

interface BuildDmMessageCreateEnvelopeInput {
  fx: DmPeerFixture;
  dmChannelId: string;
  messageId?: string;
  content?: string;
  /** Override the author id placed in the payload (for spoof / signature-mismatch tests). */
  authorRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildDmMessageCreateEnvelope(
  input: BuildDmMessageCreateEnvelopeInput,
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'dm.message.create',
    fromInstance: fx.peerHost,
    toInstance: SELF_HOST,
    payload: {
      dmChannelId: input.dmChannelId,
      messageId: input.messageId ?? ulid(),
      authorRemoteUserId:
        input.authorRemoteUserIdOverride ?? fx.initiatorRemoteUserId,
      content: input.content ?? 'hi from peer',
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.initiatorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

describe.skipIf(!dockerOk)('P5-6 — POST /_federation/event (dm.message.create)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: persists Message with origin + signature and broadcasts DM_MESSAGE_CREATE', async () => {
    const fx = await makeDmMessageFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const messageId = ulid();
    const createdAtIso = new Date(Date.now() + 1000).toISOString();
    const envelope = buildTwoLayerMessageEnvelope({
      eventType: 'dm.message.create',
      fromInstance: fx.peerHost,
      toInstance: SELF_HOST,
      payload: {
        dmChannelId: fx.dmChannelId,
        messageId,
        authorRemoteUserId: fx.initiatorRemoteUserId,
        content: 'hi from peer',
        replyToMessageId: null,
        createdAt: createdAtIso,
      },
      signUser: (b: Buffer) => edSign(b, fx.initiatorKp.privateKey),
      signInstance: (b: Buffer) => edSign(b, fx.peerKp.privateKey),
    });

    const events: Array<{
      type: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

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

      // Message row persisted with origin + signature.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row).not.toBeNull();
      expect(row!.dmChannelId).toBe(fx.dmChannelId);
      expect(row!.serverId).toBeNull();
      expect(row!.channelId).toBeNull();
      expect(row!.authorId).toBe(fx.initiatorLocalUserId);
      expect(row!.content).toBe('hi from peer');
      expect(row!.originInstanceId).toBe(fx.peerInstanceId);
      expect(row!.signature).not.toBeNull();
      expect(row!.signature!.length).toBeGreaterThan(0);
      expect(row!.createdAt.toISOString()).toBe(createdAtIso);

      // lastMessageAt advanced to the payload's createdAt (atomic with the
      // Message insert — INSIDE the handler's transaction).
      const dm = await prisma.dmChannel.findUnique({
        where: { id: fx.dmChannelId },
        select: { lastMessageAt: true },
      });
      expect(dm!.lastMessageAt).not.toBeNull();
      expect(dm!.lastMessageAt!.toISOString()).toBe(createdAtIso);

      // Gateway broadcast — DM_MESSAGE_CREATE keyed on dmChannelId, no serverId.
      const dmBroadcasts = events.filter((e) => e.type === 'DM_MESSAGE_CREATE');
      expect(dmBroadcasts).toHaveLength(1);
      expect(dmBroadcasts[0]!.dmChannelId).toBe(fx.dmChannelId);
      const dto = dmBroadcasts[0]!.data as { id: string; dmChannelId: string | null };
      expect(dto.id).toBe(messageId);
      expect(dto.dmChannelId).toBe(fx.dmChannelId);

      // Envelope log accepted + lastSeenAt advanced.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'dm.message.create' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
      expect(log!.direction).toBe('inbound');

      const ru = await prisma.remoteUser.findUnique({
        where: { remoteUserId: fx.initiatorRemoteUserId },
      });
      expect(ru!.lastSeenAt.getTime()).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('rejects with 404 when the target DmChannel does not exist locally', async () => {
    // Seed a peer + initiator but DO NOT run dm.create — the receiver
    // hasn't accepted the channel yet, so the message arrives ahead of
    // its parent envelope.
    const fx = await makeDmFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildDmMessageCreateEnvelope({
      fx,
      dmChannelId: ulid(),
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toMatch(/dm channel .* not found/i);

      // No Message row created.
      const count = await prisma.message.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects with 403 when the author User exists locally but is not a DmChannelMember', async () => {
    const fx = await makeDmMessageFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    // Drop the initiator from the channel so the membership check fails
    // but the User row + the DmChannel row are still there.
    await prisma.dmChannelMember.delete({
      where: {
        dmChannelId_userId: {
          dmChannelId: fx.dmChannelId,
          userId: fx.initiatorLocalUserId,
        },
      },
    });

    const envelope = buildDmMessageCreateEnvelope({ fx, dmChannelId: fx.dmChannelId });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/not a member of dm channel/i);

      const count = await prisma.message.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects with 404 when no local User row exists for the author', async () => {
    const fx = await makeDmMessageFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    // Drop the local mirror User entirely — we have to clear the
    // DmChannelMember first because of the FK, then the User. The
    // DmChannel row stays so we can hit the "user lookup misses"
    // branch (rather than the unknown_dm_channel branch).
    await prisma.dmChannelMember.delete({
      where: {
        dmChannelId_userId: {
          dmChannelId: fx.dmChannelId,
          userId: fx.initiatorLocalUserId,
        },
      },
    });
    await prisma.user.delete({ where: { id: fx.initiatorLocalUserId } });

    const envelope = buildDmMessageCreateEnvelope({ fx, dmChannelId: fx.dmChannelId });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toMatch(/no local user matches author/i);

      const count = await prisma.message.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('replay (same envelope POSTed twice) → first 200, second 409', async () => {
    const fx = await makeDmMessageFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildDmMessageCreateEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId: ulid(),
    });

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
    } finally {
      await app.close();
    }
  });

  it('idempotent: same messageId with a fresh nonce → 200 deduplicated', async () => {
    const fx = await makeDmMessageFixture();
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const messageId = ulid();

    try {
      // First delivery — normal happy path.
      const first = buildDmMessageCreateEnvelope({
        fx,
        dmChannelId: fx.dmChannelId,
        messageId,
      });
      const res1 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: first,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().data?.deduplicated).not.toBe(true);

      // Second delivery — same messageId, but a fresh ULID nonce so the
      // envelope-log replay guard doesn't catch it. The handler-level
      // idempotency MUST kick in.
      const second = buildDmMessageCreateEnvelope({
        fx,
        dmChannelId: fx.dmChannelId,
        messageId,
      });
      expect((second as { nonce: string }).nonce).not.toBe(
        (first as { nonce: string }).nonce,
      );
      const res2 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: second,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().data?.deduplicated).toBe(true);
      expect(res2.json().data?.id).toBe(messageId);

      // Only one Message row across both deliveries.
      const rows = await prisma.message.findMany({ where: { id: messageId } });
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('rejects with 403 when the peer does not advertise the `dms` capability', async () => {
    // Pre-stage: build the fixture WITH dms so dm.create succeeds, then
    // demote the peer's capabilities to `['messages']` so the inbound
    // dm.message.create handler hits the capability gate.
    const fx = await makeDmMessageFixture();
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: { capabilities: ['messages'] },
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const envelope = buildDmMessageCreateEnvelope({ fx, dmChannelId: fx.dmChannelId });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatch(/dms.*capability/i);

      const count = await prisma.message.count();
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5-8 — POST /_federation/event (dm.message.update + dm.message.delete)
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors P3-8 (channel message edit/delete), but for DMs. Coverage matrix:
//   1. update happy path — content + editedAt land, MessageEdit history row
//      appended, DM_MESSAGE_UPDATE broadcast fired, lastSeenAt advanced.
//   2. update non-author → 403 forbidden.
//   3. update unknown message id → 404.
//   4. update already-deleted message → 404.
//   5. update peer lacks `dms` → 403 `dms_capability_missing`.
//   6. delete happy path — soft-delete + reactions/mentions cleaned, broadcast.
//   7. delete non-author (actor) → 403 forbidden.
//   8. delete unknown message id → 404.
//   9. delete already-deleted → 200 idempotent.
//  10. delete peer lacks `dms` → 403 `dms_capability_missing`.

/**
 * Seed a federated DM Message row authored by the fixture's initiator. Used
 * as the target of subsequent dm.message.update / dm.message.delete envelopes.
 * Mirrors `seedFederatedMessage` for channels but writes a DM row.
 */
async function seedFederatedDmMessage(opts: {
  fx: DmMessageFixture;
  messageId: string;
  content?: string;
}): Promise<void> {
  await prisma.message.create({
    data: {
      id: opts.messageId,
      dmChannelId: opts.fx.dmChannelId,
      authorId: opts.fx.initiatorLocalUserId,
      type: 'default',
      content: opts.content ?? 'original federated DM content',
      originInstanceId: opts.fx.peerInstanceId,
      signature: Buffer.alloc(64, 7),
    },
  });
}

/**
 * Seed a SECOND remote user on the same DM peer fixture, materialise a local
 * mirror User for them, and add them as a member of the DmChannel. Used by
 * the non-author edit/delete rejection tests where the envelope is signed by
 * a different actor than the original author.
 */
async function seedSecondDmRemoteUser(fx: DmMessageFixture): Promise<{
  kp: ReturnType<typeof generateKeyPair>;
  remoteUserId: string;
  localUserId: string;
}> {
  const kp = generateKeyPair();
  const localpart = `carol-${ulid().slice(-6).toLowerCase()}`;
  const qualifiedId = `${localpart}@${fx.peerHost}`;
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: fx.peerInstanceId,
      remoteUserId: qualifiedId,
      displayNameCache: 'Carol from peer',
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
      displayName: 'Carol from peer',
      email: `${qualifiedId}.federated.local`,
      emailLower: `${qualifiedId}.federated.local`,
      passwordHash: null,
      remoteUserId: qualifiedId,
      remoteInstanceId: fx.peerInstanceId,
      federationKeyPublic: exportPublicKeyRaw(kp.publicKey),
    },
  });
  // Add the second remote user as a DmChannel member so the membership
  // invariants on the inbound handlers see a fully-wired participant — even
  // though the author check rejects them BEFORE membership matters, this
  // keeps the fixture self-consistent in case the handler order changes.
  await prisma.dmChannelMember.create({
    data: {
      dmChannelId: fx.dmChannelId,
      userId: localUserId,
    },
  });
  return { kp, remoteUserId: qualifiedId, localUserId };
}

interface BuildDmMessageUpdateEnvelopeInput {
  fx: DmPeerFixture;
  dmChannelId: string;
  messageId: string;
  content?: string;
  editedAt?: string;
  /** Override author id placed in the payload (NOT the signing key — for spoof tests). */
  authorRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildDmMessageUpdateEnvelope(
  input: BuildDmMessageUpdateEnvelopeInput,
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'dm.message.update',
    fromInstance: fx.peerHost,
    toInstance: SELF_HOST,
    payload: {
      dmChannelId: input.dmChannelId,
      messageId: input.messageId,
      authorRemoteUserId:
        input.authorRemoteUserIdOverride ?? fx.initiatorRemoteUserId,
      content: input.content ?? 'edited from peer',
      editedAt: input.editedAt ?? new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.initiatorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

interface BuildDmMessageDeleteEnvelopeInput {
  fx: DmPeerFixture;
  dmChannelId: string;
  messageId: string;
  deletedAt?: string;
  /** Override actor id placed in the payload. */
  actorRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildDmMessageDeleteEnvelope(
  input: BuildDmMessageDeleteEnvelopeInput,
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'dm.message.delete',
    fromInstance: fx.peerHost,
    toInstance: SELF_HOST,
    payload: {
      dmChannelId: input.dmChannelId,
      messageId: input.messageId,
      actorRemoteUserId:
        input.actorRemoteUserIdOverride ?? fx.initiatorRemoteUserId,
      deletedAt: input.deletedAt ?? new Date().toISOString(),
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.initiatorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

describe.skipIf(!dockerOk)('P5-8 — POST /_federation/event (dm.message.update)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: updates content + editedAt and appends MessageEdit history', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId, content: 'before edit' });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const editedAt = new Date('2026-05-20T10:00:00.000Z').toISOString();
    const envelope = buildDmMessageUpdateEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      content: 'after edit',
      editedAt,
    });

    const events: Array<{
      type: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

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
      expect(row!.dmChannelId).toBe(fx.dmChannelId);

      // History row preserves the pre-edit content.
      const edits = await prisma.messageEdit.findMany({ where: { messageId } });
      expect(edits).toHaveLength(1);
      expect(edits[0]!.content).toBe('before edit');
      expect(edits[0]!.editedBy).toBe(fx.initiatorLocalUserId);

      // Gateway broadcast — DM_MESSAGE_UPDATE keyed on dmChannelId.
      const dmBroadcasts = events.filter((e) => e.type === 'DM_MESSAGE_UPDATE');
      expect(dmBroadcasts).toHaveLength(1);
      expect(dmBroadcasts[0]!.dmChannelId).toBe(fx.dmChannelId);
      const dto = dmBroadcasts[0]!.data as { id: string };
      expect(dto.id).toBe(messageId);

      // Envelope log + lastSeenAt advanced.
      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'dm.message.update' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');

      const ru = await prisma.remoteUser.findUnique({
        where: { remoteUserId: fx.initiatorRemoteUserId },
      });
      expect(ru!.lastSeenAt.getTime()).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('non-author edit → 403 forbidden', async () => {
    // Seed a federated DM authored by the fixture initiator, then send a
    // dm.message.update envelope signed by a DIFFERENT remote user (carol)
    // on the same peer. Even with a valid two-layer signature the author
    // check rejects it — DMs have no moderator override.
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId, content: 'initiator wrote this' });
    const carol = await seedSecondDmRemoteUser(fx);

    const envelope = buildDmMessageUpdateEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      content: 'carol tries to edit',
      authorRemoteUserIdOverride: carol.remoteUserId,
      signUserOverride: (b: Buffer) => edSign(b, carol.kp.privateKey),
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

      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.content).toBe('initiator wrote this');
      expect(row!.editedAt).toBeNull();
      const edits = await prisma.messageEdit.findMany({ where: { messageId } });
      expect(edits).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('edit of non-existent message → 404', async () => {
    const fx = await makeDmMessageFixture();
    const envelope = buildDmMessageUpdateEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
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
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: '' },
    });
    const envelope = buildDmMessageUpdateEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
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

  it('rejects with 403 when the peer does not advertise the `dms` capability', async () => {
    // Pre-stage WITH dms so the fixture seeds; then demote the peer's
    // capabilities so the inbound update handler hits the capability gate.
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: { capabilities: ['messages'] },
    });
    const envelope = buildDmMessageUpdateEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      content: 'edit after capability drop',
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
      expect(body.error).toMatch(/dms.*capability/i);

      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.content).toBe('original federated DM content');
      expect(row!.editedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P5-8 — POST /_federation/event (dm.message.delete)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: soft-deletes message and cleans reactions + mentions', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId, content: 'about to be deleted' });

    // Collateral the soft-delete must clean up — reactions + mentions.
    // No PinnedMessage because DMs don't support pins.
    await prisma.messageReaction.create({
      data: { messageId, userId: fx.initiatorLocalUserId, emoji: ':thumbsup:' },
    });
    await prisma.userMention.create({
      data: {
        id: ulid(),
        userId: fx.recipientUserId,
        messageId,
        // userMention.channelId is nullable for DMs; the row uses
        // dmChannelId instead.
        dmChannelId: fx.dmChannelId,
        kind: 'user',
      },
    });

    const deletedAt = new Date('2026-05-20T11:00:00.000Z').toISOString();
    const envelope = buildDmMessageDeleteEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      deletedAt,
    });

    const events: Array<{
      type: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

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

      // Collateral cleaned: no reactions, no mentions.
      const reactionCount = await prisma.messageReaction.count({ where: { messageId } });
      expect(reactionCount).toBe(0);
      const mentionCount = await prisma.userMention.count({ where: { messageId } });
      expect(mentionCount).toBe(0);

      // Gateway broadcast — DM_MESSAGE_DELETE keyed on dmChannelId.
      const dmBroadcasts = events.filter((e) => e.type === 'DM_MESSAGE_DELETE');
      expect(dmBroadcasts).toHaveLength(1);
      expect(dmBroadcasts[0]!.dmChannelId).toBe(fx.dmChannelId);
      const dto = dmBroadcasts[0]!.data as {
        id: string;
        dmChannelId: string;
        deletedAt: string;
      };
      expect(dto.id).toBe(messageId);
      expect(dto.dmChannelId).toBe(fx.dmChannelId);
      expect(dto.deletedAt).toBe(deletedAt);

      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'dm.message.delete' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('non-author delete → 403 forbidden', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    const carol = await seedSecondDmRemoteUser(fx);

    const envelope = buildDmMessageDeleteEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      actorRemoteUserIdOverride: carol.remoteUserId,
      signUserOverride: (b: Buffer) => edSign(b, carol.kp.privateKey),
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

      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('delete of non-existent message → 404', async () => {
    const fx = await makeDmMessageFixture();
    const envelope = buildDmMessageDeleteEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId: ulid(),
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

  it('delete of already-deleted message → 200 idempotent', async () => {
    // A second delete envelope (different nonce, e.g. peer outbox retried
    // after the first one committed) is a no-op rather than 404 / 409.
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    const deletedAt = new Date();
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt, content: '' },
    });

    const envelope = buildDmMessageDeleteEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
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
      expect(body.data?.deduplicated).toBe(true);

      // deletedAt unchanged — original delete time preserved.
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt?.getTime()).toBe(deletedAt.getTime());
    } finally {
      await app.close();
    }
  });

  it('rejects with 403 when the peer does not advertise the `dms` capability', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: { capabilities: ['messages'] },
    });
    const envelope = buildDmMessageDeleteEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
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
      expect(body.error).toMatch(/dms.*capability/i);

      const row = await prisma.message.findUnique({ where: { id: messageId } });
      expect(row!.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5-10 — POST /_federation/event (dm.reaction.add + dm.reaction.remove)
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors P3-9 (channel reaction add/remove), but for DMs. Coverage matrix:
//   1. add happy path — MessageReaction row + REACTION_ADD broadcast.
//   2. add idempotent (same emoji/actor, fresh nonce) — 200, no duplicate row.
//   3. add custom: emoji → 403 forbidden.
//   4. add CUSTOM: emoji → 403 (case-insensitive gate).
//   5. add actor not a DmChannelMember → 403 `not_dm_member`.
//   6. add unknown message → 404 `unknown_message`.
//   7. add peer lacks `dms` → 403 `dms_capability_missing`.
//   8. remove happy path — row deleted + REACTION_REMOVE broadcast.
//   9. remove idempotent (no pre-existing row) → 200.

interface BuildDmReactionEnvelopeInput {
  fx: DmPeerFixture;
  dmChannelId: string;
  messageId: string;
  emoji?: string;
  /** Override the actor id placed in the payload. */
  actorRemoteUserIdOverride?: string;
  signUserOverride?: (bytes: Buffer) => Buffer;
  signInstanceOverride?: (bytes: Buffer) => Buffer;
}

function buildDmReactionAddEnvelope(
  input: BuildDmReactionEnvelopeInput,
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'dm.reaction.add',
    fromInstance: fx.peerHost,
    toInstance: SELF_HOST,
    payload: {
      dmChannelId: input.dmChannelId,
      messageId: input.messageId,
      actorRemoteUserId:
        input.actorRemoteUserIdOverride ?? fx.initiatorRemoteUserId,
      emoji: input.emoji ?? '👍',
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.initiatorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

function buildDmReactionRemoveEnvelope(
  input: BuildDmReactionEnvelopeInput,
): TwoLayerSignedEnvelope<unknown> {
  const { fx } = input;
  return buildTwoLayerMessageEnvelope({
    eventType: 'dm.reaction.remove',
    fromInstance: fx.peerHost,
    toInstance: SELF_HOST,
    payload: {
      dmChannelId: input.dmChannelId,
      messageId: input.messageId,
      actorRemoteUserId:
        input.actorRemoteUserIdOverride ?? fx.initiatorRemoteUserId,
      emoji: input.emoji ?? '👍',
    },
    signUser:
      input.signUserOverride ?? ((b: Buffer) => edSign(b, fx.initiatorKp.privateKey)),
    signInstance:
      input.signInstanceOverride ?? ((b: Buffer) => edSign(b, fx.peerKp.privateKey)),
  });
}

describe.skipIf(!dockerOk)('P5-10 — POST /_federation/event (dm.reaction.add)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: creates a MessageReaction row keyed on the actor local user and broadcasts REACTION_ADD', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    // Author the DM message as the LOCAL recipient (bob's peer authors a
    // message that alice reacts to is the realistic flow, but for inbound
    // we have the remote initiator reacting to a message either side
    // authored — seedFederatedDmMessage seeds an initiator-authored row,
    // which is fine for the reaction handler's invariants).
    await seedFederatedDmMessage({ fx, messageId, content: 'reactable DM' });

    const envelope = buildDmReactionAddEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      emoji: '👍',
    });

    const events: Array<{
      type: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

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
      expect(body.data?.messageId).toBe(messageId);

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(1);
      // Actor's LOCAL User id — the synthetic mirror of the initiator.
      expect(rows[0]!.userId).toBe(fx.initiatorLocalUserId);
      expect(rows[0]!.emoji).toBe('👍');

      // Gateway broadcast — REACTION_ADD keyed on dmChannelId.
      const dmBroadcasts = events.filter(
        (e) => e.type === 'REACTION_ADD' && e.dmChannelId === fx.dmChannelId,
      );
      expect(dmBroadcasts).toHaveLength(1);
      const dto = dmBroadcasts[0]!.data as {
        messageId: string;
        userId: string;
        emoji: string;
      };
      expect(dto.messageId).toBe(messageId);
      expect(dto.userId).toBe(fx.initiatorLocalUserId);
      expect(dto.emoji).toBe('👍');

      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'dm.reaction.add' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');

      const ru = await prisma.remoteUser.findUnique({
        where: { remoteUserId: fx.initiatorRemoteUserId },
      });
      expect(ru!.lastSeenAt.getTime()).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('idempotent: same (messageId, actor, emoji) twice → 200 each, only one row', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });

    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const e1 = buildDmReactionAddEnvelope({
        fx,
        dmChannelId: fx.dmChannelId,
        messageId,
        emoji: '👍',
      });
      const r1 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: e1,
      });
      expect(r1.statusCode).toBe(200);

      // Fresh envelope (different nonce) carrying the same logical reaction
      // — the envelope-log replay guard will NOT catch this; the handler's
      // unique composite key must.
      const e2 = buildDmReactionAddEnvelope({
        fx,
        dmChannelId: fx.dmChannelId,
        messageId,
        emoji: '👍',
      });
      expect((e2 as { nonce: string }).nonce).not.toBe(
        (e1 as { nonce: string }).nonce,
      );
      const r2 = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: e2,
      });
      expect(r2.statusCode).toBe(200);

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('custom: emoji reference → 403 forbidden', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });

    const envelope = buildDmReactionAddEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
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

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('CUSTOM: emoji reference → 403 (case-insensitive gate)', async () => {
    // Defence against a peer trying to slip past a case-sensitive `custom:`
    // check by sending UPPERCASE. The handler MUST lowercase before
    // comparing — same posture as the channel reaction handler.
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });

    const envelope = buildDmReactionAddEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      emoji: 'CUSTOM:abc123',
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

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('actor not a DmChannelMember → 403 `not_dm_member`', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });

    // Drop the initiator from the channel so the membership check fails
    // but the User + Message rows are still there.
    await prisma.dmChannelMember.delete({
      where: {
        dmChannelId_userId: {
          dmChannelId: fx.dmChannelId,
          userId: fx.initiatorLocalUserId,
        },
      },
    });

    const envelope = buildDmReactionAddEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
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
      expect(body.error).toMatch(/not a member of dm channel/i);

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('reaction on unknown DM message → 404 `unknown_message`', async () => {
    const fx = await makeDmMessageFixture();
    const envelope = buildDmReactionAddEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId: ulid(),
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

  it('rejects with 403 when the peer does not advertise the `dms` capability', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: { capabilities: ['messages'] },
    });

    const envelope = buildDmReactionAddEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
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
      expect(body.error).toMatch(/dms.*capability/i);

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('P5-10 — POST /_federation/event (dm.reaction.remove)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanDb();
  });

  it('happy path: removes an existing MessageReaction row and broadcasts REACTION_REMOVE', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.messageReaction.create({
      data: {
        messageId,
        userId: fx.initiatorLocalUserId,
        emoji: '👍',
      },
    });

    const envelope = buildDmReactionRemoveEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      emoji: '👍',
    });

    const events: Array<{
      type: string;
      dmChannelId?: string;
      data: unknown;
    }> = [];
    const unsubscribe = gatewayBroker.subscribe((e) => events.push(e));

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
      expect(body.data?.messageId).toBe(messageId);

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(0);

      const dmBroadcasts = events.filter(
        (e) => e.type === 'REACTION_REMOVE' && e.dmChannelId === fx.dmChannelId,
      );
      expect(dmBroadcasts).toHaveLength(1);
      const dto = dmBroadcasts[0]!.data as {
        messageId: string;
        userId: string;
        emoji: string;
      };
      expect(dto.messageId).toBe(messageId);
      expect(dto.userId).toBe(fx.initiatorLocalUserId);
      expect(dto.emoji).toBe('👍');

      const log = await prisma.federationEnvelopeLog.findFirst({
        where: { peerInstanceId: fx.peerInstanceId, eventType: 'dm.reaction.remove' },
      });
      expect(log).not.toBeNull();
      expect(log!.status).toBe('accepted');
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('idempotent: removing a non-existent reaction is a no-op (200)', async () => {
    // Mirrors the local DELETE route and the server-channel reaction
    // handler — a peer retrying after the row is already gone gets 200.
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    // Do NOT pre-create a reaction.

    const envelope = buildDmReactionRemoveEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      emoji: '👍',
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: envelope,
      });
      expect(res.statusCode).toBe(200);

      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('remove with a custom: emoji reference → 403', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });

    const envelope = buildDmReactionRemoveEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
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

  it('remove from a non-DM-member → 403 `not_dm_member`', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.messageReaction.create({
      data: {
        messageId,
        userId: fx.initiatorLocalUserId,
        emoji: '👍',
      },
    });
    // Drop the initiator from the channel — reaction stays but membership
    // gate must trip first.
    await prisma.dmChannelMember.delete({
      where: {
        dmChannelId_userId: {
          dmChannelId: fx.dmChannelId,
          userId: fx.initiatorLocalUserId,
        },
      },
    });

    const envelope = buildDmReactionRemoveEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
      emoji: '👍',
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
      expect(body.error).toMatch(/not a member of dm channel/i);

      // Reaction row untouched — gate trips before the delete.
      const rows = await prisma.messageReaction.findMany({ where: { messageId } });
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('remove on unknown DM message → 404', async () => {
    const fx = await makeDmMessageFixture();
    const envelope = buildDmReactionRemoveEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId: ulid(),
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

  it('rejects with 403 when the peer does not advertise the `dms` capability', async () => {
    const fx = await makeDmMessageFixture();
    const messageId = ulid();
    await seedFederatedDmMessage({ fx, messageId });
    await prisma.remoteInstance.update({
      where: { id: fx.peerInstanceId },
      data: { capabilities: ['messages'] },
    });

    const envelope = buildDmReactionRemoveEnvelope({
      fx,
      dmChannelId: fx.dmChannelId,
      messageId,
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
      expect(body.error).toMatch(/dms.*capability/i);
    } finally {
      await app.close();
    }
  });
});

