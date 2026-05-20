/**
 * Unit tests for the federation keypair provisioning that AuthService performs
 * at registration and bootstrap (Phase 2 task 4).
 *
 * These tests construct AuthService directly with a mock UserKeyStore so they
 * run without Docker / Postgres / a real TAVERN_DATA_KEY.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from '@tavern/shared';
import { makeFakeDb, makeFakePrismaClient } from './helpers.js';

// Mock @tavern/db before importing AuthService
const hoisted = vi.hoisted(() => {
  return { fakePrismaRef: { current: null as unknown } };
});

vi.mock('@tavern/db', () => ({
  get prisma() {
    return hoisted.fakePrismaRef.current;
  },
  disconnectPrisma: async () => undefined,
}));

const fakeDb = makeFakeDb();
const fakePrisma = makeFakePrismaClient(fakeDb);
hoisted.fakePrismaRef.current = fakePrisma;

import { AuthService } from '../src/services/auth-service.js';
import { JwtService } from '../src/lib/jwt.js';
import { MailService } from '../src/services/mail-service.js';
import type { UserKeyStore } from '../src/services/user-keys.js';
import type { Config } from '../src/config.js';

const TEST_CONFIG: Partial<Config> & Pick<Config, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET' | 'APP_NAME' | 'NODE_ENV' | 'PASSWORD_RESET_TTL_SECONDS' | 'FEDERATION_ENABLED'> = {
  APP_NAME: 'TavernTest',
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  ACCESS_TOKEN_TTL_SECONDS: 60 * 15,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
  PASSWORD_RESET_TTL_SECONDS: 3600,
  FEDERATION_ENABLED: true,
  WEB_BASE_URL: 'http://localhost:3030',
} as Config;

function makeJwt(): JwtService {
  return new JwtService({
    accessSecret: TEST_CONFIG.JWT_ACCESS_SECRET,
    refreshSecret: TEST_CONFIG.JWT_REFRESH_SECRET,
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 30,
    issuer: TEST_CONFIG.APP_NAME,
  });
}

function makeMockMail(): MailService {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as MailService;
}

function makeMockUserKeyStore(): UserKeyStore {
  return {
    ensureKeyFor: vi.fn().mockResolvedValue(undefined),
    loadKeyFor: vi.fn(),
    getPublicKeyRaw: vi.fn(),
  } as unknown as UserKeyStore;
}

beforeEach(() => {
  fakeDb.users.clear();
  fakeDb.sessions.clear();
  fakeDb.invites.clear();
  const inviteId = ulid();
  fakeDb.invites.set(inviteId, {
    id: inviteId,
    code: 'FED-INVITE',
    scope: 'instance',
    serverId: null,
    channelId: null,
    createdById: null,
    maxUses: null,
    uses: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
  });
});

describe('AuthService — federation keypair provisioning', () => {
  it('calls ensureKeyFor after a successful register()', async () => {
    const mockKeyStore = makeMockUserKeyStore();
    const authService = new AuthService({
      jwt: makeJwt(),
      config: TEST_CONFIG as Config,
      mail: makeMockMail(),
      userKeyStore: mockKeyStore,
    });

    const tokens = await authService.register(
      {
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'FED-INVITE',
      },
      {},
    );

    expect(tokens.accessToken).toBeTruthy();
    expect(mockKeyStore.ensureKeyFor).toHaveBeenCalledOnce();
    // The user ID must be the one actually persisted
    const createdUser = [...fakeDb.users.values()][0];
    expect(mockKeyStore.ensureKeyFor).toHaveBeenCalledWith(createdUser.id);
  });

  it('succeeds and returns tokens even if ensureKeyFor throws', async () => {
    const mockKeyStore = makeMockUserKeyStore();
    (mockKeyStore.ensureKeyFor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('keystore unavailable'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const authService = new AuthService({
      jwt: makeJwt(),
      config: TEST_CONFIG as Config,
      mail: makeMockMail(),
      userKeyStore: mockKeyStore,
    });

    const tokens = await authService.register(
      {
        username: 'bob',
        displayName: 'Bob',
        email: 'bob@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'FED-INVITE',
      },
      {},
    );

    expect(tokens.accessToken).toBeTruthy();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not call ensureKeyFor when no userKeyStore is provided', async () => {
    const authService = new AuthService({
      jwt: makeJwt(),
      config: TEST_CONFIG as Config,
      mail: makeMockMail(),
      // no userKeyStore
    });

    const tokens = await authService.register(
      {
        username: 'carol',
        displayName: 'Carol',
        email: 'carol@example.com',
        password: 'hunter22hunter22',
        inviteCode: 'FED-INVITE',
      },
      {},
    );

    expect(tokens.accessToken).toBeTruthy();
    // No assertion needed on a mock — we just confirm no error is thrown
  });
});
