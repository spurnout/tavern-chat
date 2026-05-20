import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@tavern/db';
import { encryptAtRest, decryptAtRest } from '../lib/at-rest.js';
import {
  generateKeyPair,
  sign as edSign,
  exportPublicKeyRaw,
  exportPrivateKeyPkcs8,
  privateKeyFromPkcs8,
} from '../lib/ed25519.js';

export interface UserKeyStoreOptions {
  dataKey: Buffer; // 32 raw bytes
  prisma?: PrismaClient;
}

export interface LoadedUserKey {
  publicKeyRaw: Buffer;
  sign: (msg: Buffer) => Buffer;
}

/**
 * Holds the per-user signing keypair. Public half lives in
 * User.federationKeyPublic; private half is AES-256-GCM encrypted at rest
 * with TAVERN_DATA_KEY and lives in User.federationKeyPrivate.
 *
 * Used in Phase 3 to sign user-authored federation envelopes. Provisioned
 * in Phase 2 (at registration + lazy backfill) so the message-signing path
 * never needs a schema migration to land.
 */
export class UserKeyStore {
  private readonly prisma: PrismaClient;

  constructor(private readonly opts: UserKeyStoreOptions) {
    this.prisma = opts.prisma ?? defaultPrisma;
  }

  /**
   * Idempotent. If the user already has a federation keypair, returns immediately.
   * Otherwise generates a fresh keypair, encrypts the private half, and writes
   * both halves into the User row.
   *
   * Safe under concurrent calls: relies on the User row being a single update —
   * a second concurrent caller may regenerate, but the last write wins. For
   * Phase 2 (registration + lazy backfill) the risk is negligible.
   */
  async ensureKeyFor(userId: string): Promise<void> {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { federationKeyPublic: true },
    });
    if (existing?.federationKeyPublic) return;
    const kp = generateKeyPair();
    const publicRaw = exportPublicKeyRaw(kp.publicKey);
    const pkcs8 = exportPrivateKeyPkcs8(kp.privateKey);
    const encrypted = encryptAtRest(pkcs8, this.opts.dataKey);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        federationKeyPublic: publicRaw,
        federationKeyPrivate: encrypted,
      },
    });
  }

  /**
   * Returns a signer for this user. Throws if the user has no keypair —
   * call ensureKeyFor first.
   */
  async loadKeyFor(userId: string): Promise<LoadedUserKey> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { federationKeyPublic: true, federationKeyPrivate: true },
    });
    if (!row?.federationKeyPublic || !row.federationKeyPrivate) {
      throw new Error(`UserKeyStore.loadKeyFor: user ${userId} has no federation keypair`);
    }
    const pkcs8 = decryptAtRest(Buffer.from(row.federationKeyPrivate), this.opts.dataKey);
    const privateKey = privateKeyFromPkcs8(pkcs8);
    const publicKeyRaw = Buffer.from(row.federationKeyPublic);
    return {
      publicKeyRaw,
      sign: (msg: Buffer) => edSign(msg, privateKey),
    };
  }

  /** Public-only lookup. Returns null if the user has no key yet. */
  async getPublicKeyRaw(userId: string): Promise<Buffer | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { federationKeyPublic: true },
    });
    if (!row?.federationKeyPublic) return null;
    return Buffer.from(row.federationKeyPublic);
  }
}
