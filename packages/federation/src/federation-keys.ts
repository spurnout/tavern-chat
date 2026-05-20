import { ulid } from '@tavern/shared';
import { prisma as defaultPrisma } from '@tavern/db';
import type { PrismaClient } from '@prisma/client';
import { encryptAtRest, decryptAtRest } from './at-rest.js';
import {
  generateKeyPair,
  sign as edSign,
  exportPublicKeyRaw,
  exportPrivateKeyPkcs8,
  privateKeyFromPkcs8,
} from './ed25519.js';
import type { KeyObject } from 'node:crypto';

interface LoadedKey {
  id: string;
  publicKeyRaw: Buffer;
  privateKey: KeyObject;
}

export interface FederationKeyStoreOptions {
  dataKey: Buffer; // 32 raw bytes
  /** Optional PrismaClient override — defaults to the @tavern/db singleton. */
  prisma?: PrismaClient;
}

/**
 * Holds the instance signing keypair. The private half is AES-256-GCM
 * encrypted at rest with TAVERN_DATA_KEY (see at-rest.ts). The public
 * half is published via the .well-known discovery doc.
 */
export class FederationKeyStore {
  private current: LoadedKey | null = null;
  private readonly prisma: PrismaClient;

  constructor(private readonly opts: FederationKeyStoreOptions) {
    this.prisma = opts.prisma ?? defaultPrisma;
  }

  /** Idempotent. Loads the current key from the DB; generates one if none exists. */
  async bootstrap(): Promise<void> {
    if (this.current) return;
    const existing = await this.prisma.federationKey.findFirst({
      where: { isCurrent: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      const pkcs8 = decryptAtRest(Buffer.from(existing.privateKey), this.opts.dataKey);
      this.current = {
        id: existing.id,
        publicKeyRaw: Buffer.from(existing.publicKey),
        privateKey: privateKeyFromPkcs8(pkcs8),
      };
      return;
    }
    const kp = generateKeyPair();
    const publicKeyRaw = exportPublicKeyRaw(kp.publicKey);
    const pkcs8 = exportPrivateKeyPkcs8(kp.privateKey);
    const encrypted = encryptAtRest(pkcs8, this.opts.dataKey);
    const id = ulid();
    await this.prisma.federationKey.create({
      data: {
        id,
        isCurrent: true,
        publicKey: publicKeyRaw,
        privateKey: encrypted,
      },
    });
    this.current = { id, publicKeyRaw, privateKey: kp.privateKey };
  }

  sign(message: Buffer): Buffer {
    if (!this.current) {
      throw new Error('FederationKeyStore: bootstrap() must be called before sign()');
    }
    return edSign(message, this.current.privateKey);
  }

  getPublicKeyRaw(): Buffer {
    if (!this.current) throw new Error('FederationKeyStore: not bootstrapped');
    return this.current.publicKeyRaw;
  }

  getPublicKeyAdvertised(): string {
    return `ed25519:${this.getPublicKeyRaw().toString('base64')}`;
  }
}
