import {
  CAPABILITIES,
  ulid,
  peeringRequestPayloadSchema,
  peeringAcceptPayloadSchema,
  type PeeringRequestPayload,
  type PeeringAcceptPayload,
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
 * P5-11 — intersect the capabilities advertised by THIS instance with the
 * capabilities advertised (or requested) by a peer, preserving the order from
 * the static `CAPABILITIES` constant so two peers running the same software
 * always produce identical arrays.
 *
 * Used at peering time to produce the `RemoteInstance.capabilities` row, which
 * is the single source of truth every fan-out helper and inbound handler reads
 * later (`peer.capabilities.includes('dms')`, etc).
 */
export function intersectCapabilities(
  local: readonly Capability[],
  peer: readonly Capability[],
): Capability[] {
  const peerSet = new Set<Capability>(peer);
  return CAPABILITIES.filter((c) => local.includes(c) && peerSet.has(c));
}

/**
 * Validates a peer hostname before any outbound discovery fetch. Prevents SSRF
 * via the unauthenticated /_federation/peering route and defence-in-depth for
 * the admin-initiate path.
 *
 * Rejects: bare IPs (IPv4/IPv6), localhost, hostnames without a dot.
 */
export function assertValidPeerHost(host: string): void {
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
  /**
   * P5-11 — what THIS instance advertises in its .well-known doc. Threaded
   * through so the peering handshake can store the INTERSECTION of (what we
   * advertise, what the peer advertises/requests) into
   * `RemoteInstance.capabilities`. Defaults to the static full set when not
   * provided (older callers / tests that don't care about gating).
   */
  localCapabilities?: readonly Capability[];
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
  private readonly localCapabilities: readonly Capability[];

  constructor(opts: FederationPeeringServiceOptions = {}) {
    this.prisma = opts.prisma ?? defaultPrisma;
    this.localCapabilities = opts.localCapabilities ?? [...CAPABILITIES];
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

    // 4. upsert the RemoteInstance row (pending_inbound).
    //
    // P5-11: store the INTERSECTION of what the peer asked for and what we
    // advertise locally. This is the single source of truth every later
    // fan-out helper and inbound handler reads (`peer.capabilities.includes(
    // 'dms')`, etc), so the intersection MUST happen at storage time — not at
    // every read site. If we ever stop advertising `dms` (operator flipped
    // FEDERATION_DMS_ENABLED to false), an already-peered RemoteInstance row
    // still carries the old, stale capability set; the inbound-side defence-
    // in-depth check on `env.FEDERATION_DMS_ENABLED` (see federation-inbound)
    // is what plugs that gap.
    const negotiated = intersectCapabilities(
      this.localCapabilities,
      env.payload.requestedCapabilities,
    );
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
          capabilities: negotiated,
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
          capabilities: negotiated,
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

  /**
   * P6-3 (follow-up #29) — handles an inbound `peering.accept` envelope on the
   * initiator side. The envelope is sent by a peer in response to our prior
   * `peering.request`, carrying the capability set the peer is willing to
   * honour. We:
   *
   *   1. Validate this is actually a peer we initiated handshake with
   *      (existing RemoteInstance row in `pending_outbound` or `peered`).
   *   2. Re-fetch the peer's discovery doc to pick up any key rotation.
   *   3. Verify the envelope signature against that fresh public key.
   *   4. Intersect the peer's accepted capabilities with our local advertised
   *      set so both sides converge on the same symmetric capability list.
   *   5. Flip the row to `peered` (or refresh capabilities + key if already
   *      `peered`, supporting re-handshake when the peer reconfigures its
   *      advertised set).
   *   6. Write the FederationEnvelopeLog row for replay protection.
   */
  async recordInboundAccept(envelopeBody: unknown): Promise<RecordInboundResult> {
    // 1. Shape-check WITHOUT signature verification first to extract fromInstance.
    const preCheck = envelopeBody as { fromInstance?: unknown; eventType?: unknown } | null;
    if (!preCheck || preCheck.eventType !== 'peering.accept') {
      throw new PeeringError('bad_envelope', 'expected eventType peering.accept');
    }
    if (typeof preCheck.fromInstance !== 'string' || preCheck.fromInstance.length === 0) {
      throw new PeeringError('bad_envelope', 'envelope missing fromInstance');
    }
    assertValidPeerHost(preCheck.fromInstance);

    // 2. Look up the existing RemoteInstance row. The accept envelope is only
    //    valid for a peer we already initiated peering with — otherwise it's a
    //    spoof attempt.
    const existing = await this.prisma.remoteInstance.findUnique({
      where: { host: preCheck.fromInstance },
    });
    if (!existing) {
      throw new PeeringError(
        'bad_envelope',
        `received peering.accept from unknown peer ${preCheck.fromInstance}`,
      );
    }
    if (existing.status === 'revoked' || existing.status === 'blocked') {
      throw new PeeringError('blocked', `peer ${preCheck.fromInstance} is ${existing.status}`);
    }

    // 3. Re-fetch the peer's discovery doc → public key. The peer key MAY have
    //    rotated since we initiated; pull fresh so the signature check uses the
    //    current key. (If the key changed, we also re-store it on the row.)
    const discovery = await discoverInstance(preCheck.fromInstance);
    const pubRaw = Buffer.from(discovery.instanceKey.replace(/^ed25519:/, ''), 'base64');

    // 4. Full verify + payload-schema check.
    const verified = verifyEnvelopeShape({
      envelope: envelopeBody,
      peerPublicKeyRaw: pubRaw,
      payloadSchema: peeringAcceptPayloadSchema,
    });
    if (!verified.ok) throw new PeeringError('signature', verified.reason);
    const env = verified.envelope as SignedEnvelope<PeeringAcceptPayload>;

    // 5. Intersect peer's accepted capabilities with ours. The peer's accept
    //    represents what they're WILLING to honour; we intersect with what WE
    //    advertise locally so the stored set is symmetric across both sides.
    const negotiated = intersectCapabilities(
      this.localCapabilities,
      env.payload.acceptedCapabilities,
    );

    // 6. Update the row. If still `pending_outbound` → flip to `peered`.
    //    If already `peered` → just refresh capabilities + key (re-handshake
    //    support, e.g. peer dropped or added a capability). Anything else is
    //    rejected.
    //
    //    TOCTOU note: the row was read at step 2, before the outbound
    //    `discoverInstance` HTTP call at step 3, which can take seconds. An
    //    admin operation that revokes the peer during that network call
    //    would have its revocation silently overwritten if we used the
    //    stale `existing.status` here. To close the window we re-read the
    //    row inside a transaction and assert its status hasn't changed
    //    before writing. The outbound HTTP + signature verify deliberately
    //    stay OUTSIDE the transaction — both are pure / outbound and would
    //    bloat the lock window for no correctness benefit.
    const payloadHash = createHash('sha256').update(canonicalize(env.payload)).digest();
    const logId = ulid();
    try {
      await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.remoteInstance.findUnique({
          where: { id: existing.id },
        });
        if (!fresh) {
          throw new PeeringError(
            'bad_envelope',
            `peer ${preCheck.fromInstance} was deleted concurrently`,
          );
        }
        if (fresh.status === 'revoked' || fresh.status === 'blocked') {
          throw new PeeringError(
            'blocked',
            `peer ${preCheck.fromInstance} is ${fresh.status}`,
          );
        }
        if (fresh.status !== 'pending_outbound' && fresh.status !== 'peered') {
          throw new PeeringError(
            'bad_envelope',
            `peer ${preCheck.fromInstance} is ${fresh.status}; cannot accept`,
          );
        }

        await tx.remoteInstance.update({
          where: { id: fresh.id },
          data: {
            instanceKey: pubRaw,
            status: 'peered',
            capabilities: negotiated,
            peeredAt: fresh.peeredAt ?? new Date(),
          },
        });

        // 7. Log envelope — unique(peerInstanceId, nonce) enforces replay
        //    protection. Inside the same transaction so that a replay-throw
        //    rolls the status flip back too — the peer must retry with a
        //    fresh nonce, and we don't want to leave the row half-updated.
        await tx.federationEnvelopeLog.create({
          data: {
            id: logId,
            direction: 'inbound',
            peerInstanceId: fresh.id,
            eventType: env.eventType,
            payloadHash,
            nonce: env.nonce,
            notBefore: new Date(env.notBefore),
            notAfter: new Date(env.notAfter),
            status: 'accepted',
            processedAt: new Date(),
          },
        });
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new PeeringError('replay', 'nonce already seen for this peer');
      }
      throw err;
    }

    return { logId, remoteInstanceId: existing.id };
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

    // P5-11: the locally-stored capability set is the intersection of
    //   (a) what we advertise locally,
    //   (b) what the peer advertises in their .well-known doc,
    //   (c) what the admin requested at peering time.
    // The envelope we send still carries (c) — the peer applies its own
    // intersection on the inbound side, so a missing peer-side capability
    // surfaces as a one-sided gap (we asked, they didn't accept) rather than
    // a hard error here. Capabilities the peer's discovery doc doesn't list
    // are stripped from OUR view so we never enqueue events the peer would
    // reject anyway.
    const peerAdvertised: Capability[] = (discovery.capabilities ?? []).filter(
      (c): c is Capability => CAPABILITIES.includes(c as Capability),
    );
    const negotiated = intersectCapabilities(
      this.localCapabilities,
      intersectCapabilities(input.requestedCapabilities, peerAdvertised),
    );

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
          capabilities: negotiated,
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
          capabilities: negotiated,
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
