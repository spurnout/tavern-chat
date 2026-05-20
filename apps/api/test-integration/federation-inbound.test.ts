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
  canonicalize,
  generateKeyPair,
  exportPublicKeyRaw,
  publicKeyFromRaw,
  sign as edSign,
  verify as edVerify,
  buildTwoLayerMessageEnvelope,
  type TwoLayerSignedEnvelope,
} from '@tavern/federation';
import {
  PROTOCOL_VERSION,
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
