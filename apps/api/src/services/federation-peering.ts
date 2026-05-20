import {
  ulid,
  peeringRequestPayloadSchema,
  type PeeringRequestPayload,
  type Capability,
} from '@tavern/shared';
import { prisma as defaultPrisma } from '@tavern/db';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { canonicalize } from '../lib/canonical-json.js';
import { verifyEnvelopeShape, buildSignedEnvelope, type SignedEnvelope } from './federation-envelopes.js';
import { discoverInstance, postPeeringEnvelope } from './federation-client.js';

/**
 * Validates a peer hostname before any outbound discovery fetch. Prevents SSRF
 * via the unauthenticated /_federation/peering route and defence-in-depth for
 * the admin-initiate path.
 *
 * Rejects: bare IPs (IPv4/IPv6), localhost, hostnames without a dot.
 */
function assertValidPeerHost(host: string): void {
  if (!host || typeof host !== 'string') {
    throw new PeeringError('bad_envelope', 'peer host is required');
  }
  const lower = host.toLowerCase();
  if (lower === 'localhost') {
    throw new PeeringError('bad_envelope', 'peer host cannot be localhost');
  }
  // Bare IPv4: digits, dots, nothing else
  if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(host)) {
    throw new PeeringError('bad_envelope', 'peer host must be a hostname, not an IPv4 address');
  }
  // IPv6: contains colon (a hostname:port shape would also match, but real
  // peer hosts don't carry a port in the discovery identifier)
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    throw new PeeringError('bad_envelope', 'peer host must not contain port or IPv6 brackets');
  }
  // Must contain at least one dot — rejects TLD-less names like "intranet"
  if (!host.includes('.')) {
    throw new PeeringError('bad_envelope', 'peer host must be a fully-qualified domain');
  }
}

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
    assertValidPeerHost(preCheck);

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

  async listPeers() {
    return this.prisma.remoteInstance.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        host: true,
        status: true,
        capabilities: true,
        peeredAt: true,
        revokedAt: true,
        revokedReason: true,
        contactEmail: true,
        createdAt: true,
      },
    });
  }

  async initiatePeering(input: InitiatePeeringInput): Promise<{ remoteInstanceId: string }> {
    assertValidPeerHost(input.host);
    const discovery = await discoverInstance(input.host);
    const pubRaw = Buffer.from(discovery.instanceKey.replace(/^ed25519:/, ''), 'base64');

    const existing = await this.prisma.remoteInstance.findUnique({ where: { host: input.host } });
    let remoteInstanceId: string;
    if (!existing) {
      remoteInstanceId = ulid();
      await this.prisma.remoteInstance.create({
        data: {
          id: remoteInstanceId,
          host: input.host,
          instanceKey: pubRaw,
          status: 'pending_outbound',
          capabilities: input.requestedCapabilities,
          note: input.note,
          peeredByUserId: input.adminUserId,
        },
      });
    } else {
      remoteInstanceId = existing.id;
      await this.prisma.remoteInstance.update({
        where: { id: existing.id },
        data: {
          instanceKey: pubRaw,
          status: 'pending_outbound',
          capabilities: input.requestedCapabilities,
          note: input.note,
          peeredByUserId: input.adminUserId,
        },
      });
    }

    const envelope = buildSignedEnvelope({
      eventType: 'peering.request',
      fromInstance: input.selfHost,
      toInstance: input.host,
      payload: {
        requestedCapabilities: input.requestedCapabilities,
        note: input.note,
      },
      sign: input.sign,
    });

    await postPeeringEnvelope(discovery.endpoints.peering, envelope);

    return { remoteInstanceId };
  }

  async approvePeer(input: {
    id: string;
    adminUserId: string;
    selfHost: string;
    sign: (bytes: Buffer) => Buffer;
  }): Promise<void> {
    const peer = await this.prisma.remoteInstance.findUnique({ where: { id: input.id } });
    if (!peer) throw new PeeringError('bad_envelope', `peer ${input.id} not found`);
    if (peer.status !== 'pending_inbound') {
      throw new PeeringError(
        'bad_envelope',
        `peer is ${peer.status}; only pending_inbound peers can be approved on this side`,
      );
    }

    await this.prisma.remoteInstance.update({
      where: { id: input.id },
      data: {
        status: 'peered',
        peeredAt: new Date(),
        peeredByUserId: input.adminUserId,
      },
    });

    // Best-effort dispatch — local state change is authoritative
    try {
      const discovery = await discoverInstance(peer.host);
      const envelope = buildSignedEnvelope({
        eventType: 'peering.accept',
        fromInstance: input.selfHost,
        toInstance: peer.host,
        payload: {
          acceptedCapabilities: (peer.capabilities as Capability[]) ?? [],
        },
        sign: input.sign,
      });
      await postPeeringEnvelope(discovery.endpoints.peering, envelope);
    } catch {
      // swallow — unreachable peer is a known gap; local state is already updated
    }
  }

  async revokePeer(input: {
    id: string;
    reason?: string;
    selfHost: string;
    sign: (bytes: Buffer) => Buffer;
  }): Promise<void> {
    const peer = await this.prisma.remoteInstance.findUnique({ where: { id: input.id } });
    if (!peer) throw new PeeringError('bad_envelope', `peer ${input.id} not found`);

    await this.prisma.remoteInstance.update({
      where: { id: input.id },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: input.reason,
      },
    });

    // Best-effort dispatch — swallow errors
    try {
      const discovery = await discoverInstance(peer.host);
      const envelope = buildSignedEnvelope({
        eventType: 'peering.revoke',
        fromInstance: input.selfHost,
        toInstance: peer.host,
        payload: { reason: input.reason },
        sign: input.sign,
      });
      await postPeeringEnvelope(discovery.endpoints.peering, envelope);
    } catch {
      // swallow — unreachable peer is a known gap
    }
  }
}

export interface InitiatePeeringInput {
  host: string;
  adminUserId: string;
  requestedCapabilities: Capability[];
  note?: string;
  sign: (bytes: Buffer) => Buffer;
  selfHost: string;
}
