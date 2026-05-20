import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { UserKeyStore } from '../src/services/user-keys.js';

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

describe.skipIf(!dockerOk)('UserKeyStore', () => {
  const dataKey = randomBytes(32);
  let store: UserKeyStore;
  let userId: string;

  beforeEach(async () => {
    // Create a fresh user for each test
    userId = ulid();
    await prisma.user.create({
      data: {
        id: userId,
        username: `tester-${userId.toLowerCase()}`,
        usernameLower: `tester-${userId.toLowerCase()}`,
        displayName: 'Tester',
        email: `${userId.toLowerCase()}@example.test`,
        emailLower: `${userId.toLowerCase()}@example.test`,
        passwordHash: '$argon2id$placeholder',
      },
    });
    store = new UserKeyStore({ dataKey, prisma });
  });

  it('ensureKeyFor generates and persists a keypair', async () => {
    await store.ensureKeyFor(userId);
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { federationKeyPublic: true, federationKeyPrivate: true },
    });
    expect(u?.federationKeyPublic?.length).toBe(32);
    expect(u?.federationKeyPrivate?.length).toBeGreaterThan(32); // version + nonce + tag + ciphertext
  });

  it('ensureKeyFor is idempotent on second call', async () => {
    await store.ensureKeyFor(userId);
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { federationKeyPublic: true },
    });
    await store.ensureKeyFor(userId);
    const after = await prisma.user.findUnique({
      where: { id: userId },
      select: { federationKeyPublic: true },
    });
    expect(after?.federationKeyPublic).toEqual(before?.federationKeyPublic);
  });

  it('loadKeyFor returns a signer that produces valid signatures', async () => {
    await store.ensureKeyFor(userId);
    const key = await store.loadKeyFor(userId);
    const sig = key.sign(Buffer.from('hello'));
    // Verify against the stored public key
    const { verify, publicKeyFromRaw } = await import('../src/lib/ed25519.js');
    const pub = publicKeyFromRaw(key.publicKeyRaw);
    expect(verify(Buffer.from('hello'), sig, pub)).toBe(true);
  });

  it('loadKeyFor throws for a user without keys', async () => {
    await expect(store.loadKeyFor(userId)).rejects.toThrow(/no federation keypair/);
  });

  it('getPublicKeyRaw returns null when missing, buffer when present', async () => {
    expect(await store.getPublicKeyRaw(userId)).toBeNull();
    await store.ensureKeyFor(userId);
    const raw = await store.getPublicKeyRaw(userId);
    expect(raw?.length).toBe(32);
  });
});
