import { ulid, peeringRequestPayloadSchema, type PeeringRequestPayload } from '@tavern/shared';
import { prisma as defaultPrisma } from '@tavern/db';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { canonicalize } from '../lib/canonical-json.js';
import { verifyEnvelopeShape, type SignedEnvelope } from './federation-envelopes.js';
import { discoverInstance } from './federation-client.js';

export interface FederationPeeringServiceOptions {
  prisma?: PrismaClient;
}

export interface RecordInboundResult {
  logId: string;
  remoteInstanceId: string;
}

export class PeeringError extends Error {
  constructor(
    public readonly code: 'bad_envelope' | 'signature' | 'replay' | 'blocked' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

export class FederationPeeringService {
  private readonly prisma: PrismaClient;

  constructor(opts: FederationPeeringServiceOptions = {}) {
    this.prisma = opts.prisma ?? defaultPrisma;
  }

  /**
   * Persists an inbound PeeringRequest after verifying the signature against
   * the sender's published instance key (fetched live from their .well-known).
   * Idempotent on the (peer, nonce) unique constraint — replays return 409.
   */
  async recordInboundRequest(envelopeBody: unknown): Promise<RecordInboundResult> {
    // 1. shape-check WITHOUT signature verification first to get fromInstance
    const preCheck = (envelopeBody as { fromInstance?: string } | null)?.fromInstance;
    if (typeof preCheck !== 'string' || preCheck.length === 0) {
      throw new PeeringError('bad_envelope', 'envelope missing fromInstance');
    }

    // 2. fetch the sender's discovery doc to get their public key
    const discovery = await discoverInstance(preCheck);
    const pubRaw = Buffer.from(discovery.instanceKey.replace(/^ed25519:/, ''), 'base64');

    // 3. full verify + payload-schema check
    const verified = verifyEnvelopeShape({
      envelope: envelopeBody,
      peerPublicKeyRaw: pubRaw,
      payloadSchema: peeringRequestPayloadSchema,
    });
    if (!verified.ok) throw new PeeringError('signature', verified.reason);
    const env = verified.envelope as SignedEnvelope<PeeringRequestPayload>;

    // 4. upsert the RemoteInstance row (pending_inbound)
    const existing = await this.prisma.remoteInstance.findUnique({ where: { host: env.fromInstance } });
    let remoteId: string;
    if (!existing) {
      remoteId = ulid();
      await this.prisma.remoteInstance.create({
        data: {
          id: remoteId,
          host: env.fromInstance,
          instanceKey: pubRaw,
          status: 'pending_inbound',
          capabilities: env.payload.requestedCapabilities,
          contactEmail: env.payload.contactEmail,
          note: env.payload.note,
        },
      });
    } else if (existing.status === 'revoked' || existing.status === 'blocked') {
      throw new PeeringError('blocked', `peer ${env.fromInstance} is ${existing.status}`);
    } else {
      remoteId = existing.id;
      // Update capability set + key if it changed; status stays as-is.
      await this.prisma.remoteInstance.update({
        where: { id: existing.id },
        data: {
          instanceKey: pubRaw,
          capabilities: env.payload.requestedCapabilities,
          note: env.payload.note,
        },
      });
    }

    // 5. log envelope — unique(peerInstanceId, nonce) enforces replay protection
    const payloadHash = createHash('sha256').update(canonicalize(env.payload)).digest();
    const logId = ulid();
    try {
      await this.prisma.federationEnvelopeLog.create({
        data: {
          id: logId,
          direction: 'inbound',
          peerInstanceId: remoteId,
          eventType: env.eventType,
          payloadHash,
          nonce: env.nonce,
          notBefore: new Date(env.notBefore),
          notAfter: new Date(env.notAfter),
          status: 'accepted',
          processedAt: new Date(),
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new PeeringError('replay', 'nonce already seen for this peer');
      }
      throw err;
    }

    return { logId, remoteInstanceId: remoteId };
  }
}
