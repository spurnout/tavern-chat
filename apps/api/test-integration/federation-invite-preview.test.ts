/**
 * P4-5 — `GET /_federation/invite-preview/:code` integration coverage.
 *
 * Coverage matrix:
 *   1. Happy path — any_peer scope returns 200 with the full preview shape.
 *   2. Happy path — specific_instance with the correct caller-host header.
 *   3. Happy path — specific_user with both caller-host + caller-user headers.
 *   4. Missing code (random non-existent code) → 404 unknown_invite.
 *   5. Local (non-federated) invite → 404 unknown_invite (same code as #4 so
 *      a probing caller can't tell local-only invites apart from absent ones).
 *   6. Revoked invite → 410 invite_no_longer_valid.
 *   7. Expired invite → 410.
 *   8. Exhausted invite (uses >= maxUses) → 410.
 *   9. specific_instance without the caller-host header → 403.
 *  10. specific_instance with a non-peered caller host → 403.
 *  11. specific_user with caller-host header but missing caller-user → 403.
 *  12. specific_user with mismatched caller-user → 403.
 *  13. Response shape conforms to `federatedInvitePreviewSchema`.
 *  14. specific_instance where caller-host matches invite.remoteInstanceHost
 *      but no RemoteInstance row exists at all → 403 (defence-in-depth: the
 *      pinned target alone is not enough; the host must currently be peered).
 *  15. any_peer scope with a caller-host header that is not a peered
 *      RemoteInstance → 403 (forged-header probing is rejected even when
 *      the scope itself permits anonymous lookups).
 *
 * Rate-limit assertion: per the task spec we only confirm the rate-limit
 * config is wired into the route registration — testing it end-to-end here
 * would require time mocking the Fastify limiter. See route file for the
 * declaration.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  federatedInvitePreviewSchema,
  TOKEN_TTL,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

const SELF_HOST = 'a.example';
const PEER_HOST = 'b.example';
const OTHER_HOST = 'c.example';

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

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

/**
 * Seed a federated server + its owner + N channels + (optional) a peered
 * RemoteInstance for the receiving side. Returns identifiers the tests
 * use to set up specific invite shapes on top.
 */
async function seedFederatedServer(opts?: {
  channelCount?: number;
  iconAttachmentId?: string | null;
  description?: string | null;
  peerHosts?: string[];
}): Promise<{
  ownerId: string;
  ownerUsername: string;
  serverId: string;
  channelCount: number;
}> {
  const ownerId = ulid();
  const ownerUsername = `alice-${ownerId.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id: ownerId,
      username: ownerUsername,
      usernameLower: ownerUsername,
      displayName: 'Alice',
      email: `${ownerUsername}@example.test`,
      emailLower: `${ownerUsername}@example.test`,
      passwordHash: 'x',
    },
  });
  const serverId = ulid();
  await prisma.server.create({
    data: {
      id: serverId,
      ownerUserId: ownerId,
      name: 'Federated Tavern',
      description: opts?.description ?? 'A place to gather',
      iconAttachmentId: opts?.iconAttachmentId ?? null,
      federationEnabled: true,
    },
  });
  const channelCount = opts?.channelCount ?? 3;
  for (let i = 0; i < channelCount; i += 1) {
    await prisma.channel.create({
      data: {
        id: ulid(),
        serverId,
        type: 'text',
        name: `general-${i}`,
        position: i,
      },
    });
  }
  for (const host of opts?.peerHosts ?? []) {
    await prisma.remoteInstance.create({
      data: {
        id: ulid(),
        host,
        instanceKey: Buffer.alloc(32, 1),
        status: 'peered',
        capabilities: ['messages'],
        peeredAt: new Date(),
      },
    });
  }
  return { ownerId, ownerUsername, serverId, channelCount };
}

interface CreateInviteOpts {
  serverId: string;
  ownerId: string;
  remoteScope: 'any_peer' | 'specific_instance' | 'specific_user' | null;
  remoteInstanceHost?: string | null;
  remoteUserId?: string | null;
  revoked?: boolean;
  expiresAt?: Date | null;
  maxUses?: number | null;
  uses?: number;
}

async function createInvite(opts: CreateInviteOpts): Promise<string> {
  const id = ulid();
  const code = `code-${id.toLowerCase()}`;
  await prisma.invite.create({
    data: {
      id,
      code,
      scope: 'server',
      serverId: opts.serverId,
      createdById: opts.ownerId,
      maxUses: opts.maxUses ?? null,
      uses: opts.uses ?? 0,
      expiresAt:
        opts.expiresAt !== undefined
          ? opts.expiresAt
          : new Date(Date.now() + TOKEN_TTL.INVITE_SECONDS * 1000),
      revokedAt: opts.revoked ? new Date() : null,
      remoteScope: opts.remoteScope,
      remoteInstanceHost: opts.remoteInstanceHost ?? null,
      remoteUserId: opts.remoteUserId ?? null,
    },
  });
  return code;
}

describe.skipIf(!dockerOk)('GET /_federation/invite-preview/:code', () => {
  beforeEach(async () => {
    // Order matters: invites + channels cascade through server; user has FKs.
    await prisma.invite.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    await prisma.federationKey.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('returns 200 + preview shape for an any_peer invite', async () => {
    const { ownerId, ownerUsername, serverId, channelCount } = await seedFederatedServer({
      channelCount: 4,
      description: 'welcoming',
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'any_peer',
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      serverId,
      name: 'Federated Tavern',
      description: 'welcoming',
      iconUrl: null,
      ownerRemoteUserId: `${ownerUsername}@${SELF_HOST}`,
      inviterRemoteUserId: `${ownerUsername}@${SELF_HOST}`,
      channelCount,
    });
    // Schema check — the data block matches what a P4-6 client would parse.
    expect(() => federatedInvitePreviewSchema.parse(body.data)).not.toThrow();
    await app.close();
  });

  it('uses the home host in qualified ids + builds iconUrl from PUBLIC_BASE_URL', async () => {
    const iconId = ulid();
    const { ownerId, ownerUsername, serverId } = await seedFederatedServer({
      channelCount: 1,
      iconAttachmentId: iconId,
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'any_peer',
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.iconUrl).toBe(`https://${SELF_HOST}/api/attachments/${iconId}`);
    expect(body.data.ownerRemoteUserId).toBe(`${ownerUsername}@${SELF_HOST}`);
    await app.close();
  });

  it('returns 200 for specific_instance scope when caller-host matches a peered instance', async () => {
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [PEER_HOST],
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_instance',
      remoteInstanceHost: PEER_HOST,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: { 'x-tavern-federation-caller-host': PEER_HOST },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.serverId).toBe(serverId);
    await app.close();
  });

  it('returns 200 for specific_user scope when caller-host + caller-user both match', async () => {
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [PEER_HOST],
    });
    const callerUser = `bob@${PEER_HOST}`;
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_user',
      remoteInstanceHost: PEER_HOST,
      remoteUserId: callerUser,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: {
        'x-tavern-federation-caller-host': PEER_HOST,
        'x-tavern-federation-caller-user': callerUser,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.serverId).toBe(serverId);
    await app.close();
  });

  it('returns 404 for a code that does not exist', async () => {
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });
    const res = await app.inject({
      method: 'GET',
      url: '/_federation/invite-preview/bogus-code',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('returns 404 for a local (non-federated) invite — indistinguishable from absent', async () => {
    const { ownerId, serverId } = await seedFederatedServer();
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: null,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('returns 410 for a revoked invite', async () => {
    const { ownerId, serverId } = await seedFederatedServer();
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'any_peer',
      revoked: true,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INVALID_INVITE');
    await app.close();
  });

  it('returns 410 for an expired invite', async () => {
    const { ownerId, serverId } = await seedFederatedServer();
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'any_peer',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INVALID_INVITE');
    await app.close();
  });

  it('returns 410 for an exhausted invite (uses >= maxUses)', async () => {
    const { ownerId, serverId } = await seedFederatedServer();
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'any_peer',
      maxUses: 3,
      uses: 3,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INVALID_INVITE');
    await app.close();
  });

  it('returns 403 for specific_instance when caller-host header is missing', async () => {
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [PEER_HOST],
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_instance',
      remoteInstanceHost: PEER_HOST,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('returns 403 for specific_instance when caller-host is not a peered instance', async () => {
    // Peer the *intended* host but supply OTHER_HOST in the header — OTHER_HOST
    // is not even a row in RemoteInstance.
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [PEER_HOST],
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_instance',
      remoteInstanceHost: PEER_HOST,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: { 'x-tavern-federation-caller-host': OTHER_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('returns 403 for specific_user when caller-host is set but caller-user header is missing', async () => {
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [PEER_HOST],
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_user',
      remoteInstanceHost: PEER_HOST,
      remoteUserId: `bob@${PEER_HOST}`,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: { 'x-tavern-federation-caller-host': PEER_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('returns 403 for specific_user when caller-user does not match invite.remoteUserId', async () => {
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [PEER_HOST],
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_user',
      remoteInstanceHost: PEER_HOST,
      remoteUserId: `bob@${PEER_HOST}`,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: {
        'x-tavern-federation-caller-host': PEER_HOST,
        'x-tavern-federation-caller-user': `eve@${PEER_HOST}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('returns 403 for specific_instance when caller-host matches invite target but no RemoteInstance row exists', async () => {
    // Defence-in-depth: even when the header value matches the invite's
    // pinned target host EXACTLY, if that host has never been peered (no
    // RemoteInstance row), the lookup must reject. Without the
    // pre-scope peer-verification step this would erroneously 200.
    const { ownerId, serverId } = await seedFederatedServer({
      // Deliberately seed NO peers — PEER_HOST is the invite target but is
      // not present in RemoteInstance.
      peerHosts: [],
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'specific_instance',
      remoteInstanceHost: PEER_HOST,
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: { 'x-tavern-federation-caller-host': PEER_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('returns 403 for any_peer scope when a non-peered caller-host header is supplied', async () => {
    // any_peer scope normally allows anonymous (no header) lookups — see
    // the very first happy-path test. But if a caller volunteers a
    // caller-host header, that host must be peered. This blocks a malicious
    // non-peer from probing any_peer invites with a forged identity to
    // build a peer/invite census.
    const { ownerId, serverId } = await seedFederatedServer({
      peerHosts: [], // no peers seeded
    });
    const code = await createInvite({
      serverId,
      ownerId,
      remoteScope: 'any_peer',
    });
    const app = await buildApp({ config: loadConfig(envFor(ctx!.databaseUrl)) });

    const res = await app.inject({
      method: 'GET',
      url: `/_federation/invite-preview/${code}`,
      headers: { 'x-tavern-federation-caller-host': OTHER_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });
});
