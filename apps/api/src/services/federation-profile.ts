// (Outbound client method will be added in P2-6. Phase 2 task 5 implements only
// the inbound side — handling profile.request from a peered instance.)
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@tavern/db';
import {
  profileRequestPayloadSchema,
  profileResponsePayloadSchema,
  type ProfileRequestPayload,
} from '@tavern/shared';
import {
  verifyEnvelopeShape,
  buildSignedEnvelope,
  type SignedEnvelope,
} from './federation-envelopes.js';
import type { FederationKeyStore } from './federation-keys.js';
import type { UserKeyStore } from './user-keys.js';
import { PeeringError } from './federation-peering.js';

export interface FederationProfileServiceOptions {
  keys: FederationKeyStore;
  userKeys: UserKeyStore;
  selfHost: string;
  prisma?: PrismaClient;
}

export interface RespondToProfileRequestResult {
  envelope: SignedEnvelope<unknown>;
}

export class FederationProfileService {
  private readonly prisma: PrismaClient;
  constructor(private readonly opts: FederationProfileServiceOptions) {
    this.prisma = opts.prisma ?? defaultPrisma;
  }

  /**
   * Verify an inbound profile.request envelope, look up the requested local
   * user, ensure they have a federation keypair, and build a signed
   * profile.response envelope to return.
   *
   * Throws PeeringError with codes:
   *   - bad_envelope: malformed envelope shape or missing fromInstance
   *   - signature: signature verification failed
   *   - blocked: peer instance is not peered (status != 'peered')
   *   - bad_envelope (also): local user not found (404 from route)
   */
  async respondToProfileRequest(envelopeBody: unknown): Promise<RespondToProfileRequestResult> {
    const preCheck = (envelopeBody as { fromInstance?: string } | null)?.fromInstance;
    if (typeof preCheck !== 'string' || preCheck.length === 0) {
      throw new PeeringError('bad_envelope', 'envelope missing fromInstance');
    }

    // Peer must already be peered — profile lookup is not allowed pre-peering.
    const peer = await this.prisma.remoteInstance.findUnique({ where: { host: preCheck } });
    if (!peer) {
      throw new PeeringError('blocked', `host ${preCheck} is not a known peer`);
    }
    if (peer.status !== 'peered') {
      throw new PeeringError('blocked', `peer ${preCheck} is ${peer.status}, not peered`);
    }

    // Verify envelope signature using the peer's stored instance key.
    const verified = verifyEnvelopeShape({
      envelope: envelopeBody,
      peerPublicKeyRaw: Buffer.from(peer.instanceKey),
      payloadSchema: profileRequestPayloadSchema,
    });
    if (!verified.ok) throw new PeeringError('signature', verified.reason);
    const env = verified.envelope as SignedEnvelope<ProfileRequestPayload>;

    // Look up the local user by username matching the localpart.
    const user = await this.prisma.user.findUnique({
      where: { usernameLower: env.payload.localpart.toLowerCase() },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarAttachmentId: true,
        federationKeyPublic: true,
      },
    });
    if (!user) {
      throw new PeeringError('bad_envelope', `no user ${env.payload.localpart} on this instance`);
    }

    // Lazy keypair backfill — if a pre-federation user is being asked about,
    // we generate their keypair now.
    let publicKeyRaw: Buffer;
    if (user.federationKeyPublic) {
      publicKeyRaw = Buffer.from(user.federationKeyPublic);
    } else {
      await this.opts.userKeys.ensureKeyFor(user.id);
      const raw = await this.opts.userKeys.getPublicKeyRaw(user.id);
      if (!raw) {
        throw new Error('federation key was not provisioned after ensureKeyFor');
      }
      publicKeyRaw = raw;
    }

    const responsePayload = {
      remoteUserId: `${user.username}@${this.opts.selfHost}`,
      displayName: user.displayName,
      avatarUrl: this.deriveAvatarUrl(user.avatarAttachmentId) ?? undefined,
      publicKey: `ed25519:${publicKeyRaw.toString('base64')}`,
    };

    // Validate our own response against the schema (defence in depth).
    profileResponsePayloadSchema.parse(responsePayload);

    const responseEnvelope = buildSignedEnvelope({
      eventType: 'profile.response',
      fromInstance: this.opts.selfHost,
      toInstance: env.fromInstance,
      payload: responsePayload,
      sign: (bytes) => this.opts.keys.sign(bytes),
    });
    return { envelope: responseEnvelope };
  }

  /**
   * Derive a public avatar URL from an attachment id. Returns null if no avatar.
   * For Phase 2: simple URL based on PUBLIC_BASE_URL is enough — the peer just
   * caches the URL.
   */
  private deriveAvatarUrl(attachmentId: string | null): string | null {
    if (!attachmentId) return null;
    // The attachment lookup endpoint is at /api/attachments/:id — peers can
    // fetch it directly. For Phase 2 we trust the existing attachment route to
    // serve the right thing; we just construct a URL.
    return `https://${this.opts.selfHost}/api/attachments/${attachmentId}`;
  }
}
