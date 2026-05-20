import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { FederationKeyStore } from '../src/services/federation-keys.js';

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

describe.skipIf(!dockerOk)('FederationKeyStore', () => {
  const dataKey = randomBytes(32);
  let store: FederationKeyStore;

  beforeEach(async () => {
    await prisma.federationKey.deleteMany({});
    store = new FederationKeyStore({ dataKey, prisma });
  });

  it('generates and persists a key on first call', async () => {
    await store.bootstrap();
    const rows = await prisma.federationKey.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].publicKey.length).toBe(32);
  });

  it('is idempotent on second bootstrap', async () => {
    await store.bootstrap();
    const before = (await prisma.federationKey.findFirst())!;
    await store.bootstrap();
    const after = (await prisma.federationKey.findFirst())!;
    expect(after.id).toBe(before.id);
  });

  it('signs a message and the public key verifies it', async () => {
    await store.bootstrap();
    const sig = store.sign(Buffer.from('hello'));
    const { verify, publicKeyFromRaw } = await import('../src/lib/ed25519.js');
    const pub = publicKeyFromRaw(store.getPublicKeyRaw());
    expect(verify(Buffer.from('hello'), sig, pub)).toBe(true);
  });

  it('refuses to sign before bootstrap', () => {
    expect(() => store.sign(Buffer.from('x'))).toThrow(/bootstrap/i);
  });
});
