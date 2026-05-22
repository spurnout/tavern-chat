import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@tavern/db';
import {
  profileRequestPayloadSchema,
  profileResponsePayloadSchema,
  type ProfileRequestPayload,
  type ProfileResponsePayload,
  ulid,
} from '@tavern/shared';
import {
  verifyEnvelopeShape,
  buildSignedEnvelope,
  type SignedEnvelope,
} from './federation-envelopes.js';
import type { FederationKeyStore } from './federation-keys.js';
import type { UserKeyStore } from './user-keys.js';
import { PeeringError, assertValidPeerHost } from './federation-peering.js';
import { discoverInstance, postProfileEnvelope } from './federation-client.js';

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

    // Note: assertValidPeerHost is intentionally not called here. This is an inbound-only
    // handler — no outbound network fetch is triggered, so the SSRF surface is zero.
    // The downstream peer.status === 'peered' check is sufficient authorization.

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
   * Look up a remote user by their qualified id ("alice@b.example").
   * - Returns cached row if RemoteUser exists and lastSeenAt < 1 hour old.
   * - Otherwise discovers the peer's .well-known, posts a signed profile.request envelope,
   *   verifies the signed response, and upserts the RemoteUser row.
   *
   * Throws if:
   *   - remoteUserId is malformed (must contain exactly one '@' with non-empty parts)
   *   - the host is not a peered RemoteInstance
   *   - the peer is unreachable (propagates fetch error)
   *   - the response signature does not verify
   *   - the response envelope payload does not match profileResponsePayloadSchema
   */
  async fetchRemoteProfile(remoteUserId: string): Promise<CachedRemoteUser> {
    const parsed = parseRemoteUserId(remoteUserId);
    if (!parsed) {
      throw new Error(`invalid remoteUserId: ${remoteUserId}`);
    }
    const { localpart, host } = parsed;
    await assertValidPeerHost(host); // SSRF guard — same check applied to all outbound fetch paths

    // Find peered instance for this host.
    const peer = await this.prisma.remoteInstance.findUnique({ where: { host } });
    if (!peer || peer.status !== 'peered') {
      throw new Error(`host ${host} is not a peered remote instance`);
    }

    // Cache lookup.
    const cached = await this.prisma.remoteUser.findUnique({ where: { remoteUserId } });
    if (cached && Date.now() - cached.lastSeenAt.getTime() < CACHE_TTL_MS) {
      return {
        id: cached.id,
        remoteInstanceId: cached.remoteInstanceId,
        remoteUserId: cached.remoteUserId,
        displayNameCache: cached.displayNameCache,
        avatarUrlCache: cached.avatarUrlCache,
        publicKey: Buffer.from(cached.publicKey),
        lastSeenAt: cached.lastSeenAt,
      };
    }

    // Cache miss or stale — re-fetch.
    const discovery = await discoverInstance(host);
    const requestEnvelope = buildSignedEnvelope({
      eventType: 'profile.request',
      fromInstance: this.opts.selfHost,
      toInstance: host,
      payload: { localpart },
      sign: (bytes) => this.opts.keys.sign(bytes),
    });
    const rawResponse = await postProfileEnvelope(
      `https://${host}/_federation/profile`,
      requestEnvelope,
    );

    // Verify signed response against the peer's published instance key.
    const peerPublicKeyRaw = Buffer.from(discovery.instanceKey.replace(/^ed25519:/, ''), 'base64');
    const verified = verifyEnvelopeShape({
      envelope: rawResponse,
      peerPublicKeyRaw,
      payloadSchema: profileResponsePayloadSchema,
    });
    if (!verified.ok) {
      throw new Error(`profile response signature/shape invalid: ${verified.reason}`);
    }
    const env = verified.envelope as SignedEnvelope<ProfileResponsePayload>;

    // Upsert.
    const publicKey = Buffer.from(env.payload.publicKey.replace(/^ed25519:/, ''), 'base64');
    const id = cached?.id ?? ulid();
    await this.prisma.remoteUser.upsert({
      where: { remoteUserId },
      create: {
        id,
        remoteInstanceId: peer.id,
        remoteUserId,
        displayNameCache: env.payload.displayName,
        avatarUrlCache: env.payload.avatarUrl ?? null,
        publicKey,
        lastSeenAt: new Date(),
      },
      update: {
        displayNameCache: env.payload.displayName,
        avatarUrlCache: env.payload.avatarUrl ?? null,
        publicKey,
        lastSeenAt: new Date(),
      },
    });
    const updated = await this.prisma.remoteUser.findUniqueOrThrow({ where: { remoteUserId } });
    return {
      id: updated.id,
      remoteInstanceId: updated.remoteInstanceId,
      remoteUserId: updated.remoteUserId,
      displayNameCache: updated.displayNameCache,
      avatarUrlCache: updated.avatarUrlCache,
      publicKey: Buffer.from(updated.publicKey),
      lastSeenAt: updated.lastSeenAt,
    };
  }

  /** Cache-only lookup. Returns null if no row exists. Does not check TTL. */
  async getCachedRemoteProfile(remoteUserId: string): Promise<CachedRemoteUser | null> {
    const cached = await this.prisma.remoteUser.findUnique({ where: { remoteUserId } });
    if (!cached) return null;
    return {
      id: cached.id,
      remoteInstanceId: cached.remoteInstanceId,
      remoteUserId: cached.remoteUserId,
      displayNameCache: cached.displayNameCache,
      avatarUrlCache: cached.avatarUrlCache,
      publicKey: Buffer.from(cached.publicKey),
      lastSeenAt: cached.lastSeenAt,
    };
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

// --- module-level types and helpers ---

interface CachedRemoteUser {
  id: string;
  remoteInstanceId: string;
  remoteUserId: string;
  displayNameCache: string;
  avatarUrlCache: string | null;
  publicKey: Buffer;
  lastSeenAt: Date;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function parseRemoteUserId(s: string): { localpart: string; host: string } | null {
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  if (s.indexOf('@', at + 1) !== -1) return null; // exactly one '@'
  const localpart = s.slice(0, at);
  const host = s.slice(at + 1);
  if (!host.includes('.')) return null;
  if (!/^[a-z0-9_.-]+$/i.test(localpart)) return null;
  return { localpart, host };
}
