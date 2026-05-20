/**
 * Integration tests for `ensureUserForRemoteUser` — the federation Phase 3
 * service that materializes a RemoteUser row as a local User row so message
 * fan-out targets, mention lookups, and FK constraints all "just work".
 *
 * Covers (per task P3-4):
 *   1. New User row is created with the spec'd synthetic identifiers.
 *   2. The function is idempotent on repeat calls for the same RemoteUser.
 *   3. Concurrent calls don't double-create (P2002 race recovery).
 *   4. Remote users (passwordHash === null) cannot authenticate via login.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { ErrorCodes, ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { ensureUserForRemoteUser } from '../src/services/remote-user-upsert.js';
import { AuthService } from '../src/services/auth-service.js';
import { JwtService } from '../src/lib/jwt.js';
import type { MailService } from '../src/services/mail-service.js';
import type { Config } from '../src/config.js';

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

/**
 * Helper: insert a RemoteInstance + RemoteUser, return the RemoteUser row
 * fetched fresh from Postgres so `publicKey` is the canonical Buffer Prisma
 * returns on read (rather than whatever buffer shape we happened to pass in).
 */
async function makeRemoteUser(opts: {
  displayName?: string;
  publicKey?: Buffer;
} = {}): Promise<{
  remoteUser: Awaited<ReturnType<typeof prisma.remoteUser.findUniqueOrThrow>>;
  peerId: string;
}> {
  const peerId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host: `peer-${peerId.toLowerCase()}.example`,
      instanceKey: Buffer.alloc(32, 2),
      status: 'peered',
      capabilities: ['messages'],
    },
  });
  const rid = ulid();
  await prisma.remoteUser.create({
    data: {
      id: rid,
      remoteInstanceId: peerId,
      remoteUserId: `alice-${rid.toLowerCase()}@peer-${peerId.toLowerCase()}.example`,
      displayNameCache: opts.displayName ?? 'Alice from B',
      avatarUrlCache: null,
      publicKey: opts.publicKey ?? Buffer.alloc(32, 11),
    },
  });
  const remoteUser = await prisma.remoteUser.findUniqueOrThrow({ where: { id: rid } });
  return { remoteUser, peerId };
}

describe.skipIf(!dockerOk)('ensureUserForRemoteUser', () => {
  it('creates a User row with the spec synthetic identifiers when none exists', async () => {
    const { remoteUser, peerId } = await makeRemoteUser({
      displayName: 'Alice from B',
      publicKey: Buffer.alloc(32, 0x42),
    });

    const user = await ensureUserForRemoteUser(remoteUser, prisma);

    expect(user.username.startsWith('__rem_')).toBe(true);
    expect(user.usernameLower).toBe(user.username.toLowerCase());
    expect(user.email.endsWith('.federated.local')).toBe(true);
    expect(user.emailLower).toBe(user.email.toLowerCase());
    expect(user.passwordHash).toBeNull();
    expect(user.displayName).toBe('Alice from B');
    expect(user.remoteUserId).toBe(remoteUser.remoteUserId);
    expect(user.remoteInstanceId).toBe(peerId);
    expect(user.federationKeyPublic).not.toBeNull();
    // Compare bytes (Prisma returns Bytes as Buffer/Uint8Array).
    expect(Buffer.from(user.federationKeyPublic as Buffer).equals(Buffer.alloc(32, 0x42))).toBe(true);
  });

  it('is idempotent on repeat calls for the same RemoteUser', async () => {
    const { remoteUser } = await makeRemoteUser();

    const first = await ensureUserForRemoteUser(remoteUser, prisma);
    const second = await ensureUserForRemoteUser(remoteUser, prisma);

    expect(second.id).toBe(first.id);

    const count = await prisma.user.count({
      where: { remoteUserId: remoteUser.remoteUserId },
    });
    expect(count).toBe(1);
  });

  it('serializes concurrent calls so exactly one User row is created', async () => {
    const { remoteUser } = await makeRemoteUser();

    // Race two ensures in parallel. The unique constraint on remoteUserId is
    // what enforces single creation; the function must recover from the P2002.
    const [a, b] = await Promise.all([
      ensureUserForRemoteUser(remoteUser, prisma),
      ensureUserForRemoteUser(remoteUser, prisma),
    ]);

    expect(a.id).toBe(b.id);

    const count = await prisma.user.count({
      where: { remoteUserId: remoteUser.remoteUserId },
    });
    expect(count).toBe(1);
  });

  it('rejects login attempts for remote users (passwordHash is null)', async () => {
    const { remoteUser } = await makeRemoteUser();
    const user = await ensureUserForRemoteUser(remoteUser, prisma);

    // Construct a real AuthService pointed at the integration Postgres. We
    // don't need a working mail service for the login path; provide a stub.
    const config = {
      APP_NAME: 'TavernTest',
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'a'.repeat(48),
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      ACCESS_TOKEN_TTL_SECONDS: 60 * 15,
      REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
      PASSWORD_RESET_TTL_SECONDS: 3600,
      FEDERATION_ENABLED: true,
      WEB_BASE_URL: 'http://localhost:3030',
    } as unknown as Config;
    const jwt = new JwtService({
      accessSecret: config.JWT_ACCESS_SECRET,
      refreshSecret: config.JWT_REFRESH_SECRET,
      accessTtlSeconds: 60 * 15,
      refreshTtlSeconds: 60 * 60 * 24 * 30,
      issuer: config.APP_NAME,
    });
    const mail = { send: async () => undefined } as unknown as MailService;
    const auth = new AuthService({ jwt, config, mail });

    // The login route looks up by usernameLower OR emailLower. Either path
    // hits the user we just upserted; both must reject with INVALID_CREDENTIALS.
    await expect(
      auth.login({ identifier: user.username, password: 'whatever-does-not-matter' }, {}),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_CREDENTIALS });

    await expect(
      auth.login({ identifier: user.email, password: 'whatever-does-not-matter' }, {}),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_CREDENTIALS });
  });
});
