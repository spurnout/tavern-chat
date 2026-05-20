/**
 * Federation Phase 4 — service layer for `GET /_federation/invite-preview/:code`.
 *
 * Public, unauthenticated endpoint served by the *home* instance (the one that
 * minted the invite). The *receiving* instance fetches this on behalf of its
 * user so it can render a "join Federated Tavern on a.example?" confirmation
 * before kicking off the actual member.join_request flow.
 *
 * This module is the pure business-logic core. The Fastify route in
 * `apps/api/src/routes/federation-invite-preview.ts` is the thin HTTP
 * translator that maps `PreviewError.code` to a status code and adds the
 * rate-limit wrapper. Keeping the logic free of `req`/`reply` keeps the
 * unit-testable surface small and lets us call it from background tasks if
 * we ever need to.
 *
 * Scope semantics — `Invite.remoteScope`:
 *   - `any_peer` — no scope check; any caller IP gets the preview.
 *   - `specific_instance` — caller must supply `callerHost` AND that host
 *     must currently be a peered `RemoteInstance`. Used so an invite for
 *     b.example doesn't leak metadata to c.example.
 *   - `specific_user` — same `callerHost` check AND `callerUser` must
 *     equal `invite.remoteUserId` (the pinned qualified identity).
 *
 * Errors fold into `PreviewError` with one of four codes:
 *   - `unknown_invite` (404) — invite row missing OR `remoteScope` is null
 *     (local invite). Same code on both paths to avoid letting an attacker
 *     enumerate local-only invite codes.
 *   - `invite_no_longer_valid` (410) — revoked, expired, or exhausted.
 *   - `forbidden` (403) — scope check failed.
 *   - `internal` (500) — programmer error, e.g. an invite whose serverId
 *     points at a deleted Server. Surfaced via thrown `Error`, not
 *     `PreviewError`, so the error handler logs it.
 */

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@tavern/db';
import type { FederatedInvitePreview } from '@tavern/shared';

export type PreviewErrorCode =
  | 'unknown_invite'
  | 'invite_no_longer_valid'
  | 'forbidden';

export class PreviewError extends Error {
  public readonly code: PreviewErrorCode;
  constructor(code: PreviewErrorCode, message: string) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
  }
}

export interface PreviewFederatedInviteInput {
  /** Invite code from the URL. */
  code: string;
  /** Value of `X-Tavern-Federation-Caller-Host` header, if present. */
  callerHost?: string | null;
  /** Value of `X-Tavern-Federation-Caller-User` header, if present. */
  callerUser?: string | null;
  /**
   * Prisma client. Optional — falls back to the `@tavern/db` singleton when
   * omitted, matching the pattern used by FederationProfileService /
   * FederationInboundService.
   */
  prisma?: PrismaClient;
  /** This instance's federation host (e.g. `a.example`). */
  selfHost: string;
}

/**
 * Resolve an invite code into the public preview shape, applying the
 * scope-specific access gate. Returns the wire DTO on success; throws
 * `PreviewError` with a coded reason on any expected failure path.
 */
export async function previewFederatedInvite(
  input: PreviewFederatedInviteInput,
): Promise<FederatedInvitePreview> {
  const { code, callerHost, callerUser, selfHost } = input;
  const prisma = input.prisma ?? defaultPrisma;

  // Single round-trip — pull the invite plus everything we need to render
  // the response on the happy path. Avoids a fan-out of point lookups when
  // the gate passes.
  const invite = await prisma.invite.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      scope: true,
      serverId: true,
      maxUses: true,
      uses: true,
      expiresAt: true,
      revokedAt: true,
      createdById: true,
      remoteScope: true,
      remoteInstanceHost: true,
      remoteUserId: true,
    },
  });

  if (!invite) {
    throw new PreviewError('unknown_invite', 'invite not found');
  }

  // Local-only invites are indistinguishable from non-existent invites on
  // this surface — federated peers must not be able to discover local
  // invite codes by brute force.
  if (invite.remoteScope === null) {
    throw new PreviewError('unknown_invite', 'invite is not federated');
  }

  // Validity gate — order matters for human-readable failure messages but
  // the wire code is the same (410) for all three.
  if (invite.revokedAt) {
    throw new PreviewError('invite_no_longer_valid', 'invite has been revoked');
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new PreviewError('invite_no_longer_valid', 'invite has expired');
  }
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
    throw new PreviewError('invite_no_longer_valid', 'invite has been fully used');
  }

  // Scope-specific access check.
  if (invite.remoteScope === 'specific_instance' || invite.remoteScope === 'specific_user') {
    if (!callerHost) {
      throw new PreviewError('forbidden', 'caller host header required');
    }
    // The host pinned on the invite is the source of truth — even if the
    // RemoteInstance row was unpeered after the invite was minted, the
    // caller still has to be the same host the inviter targeted. We then
    // ALSO require the host to currently be a peered instance so a
    // previously-peered-then-revoked instance can't keep redeeming.
    if (callerHost !== invite.remoteInstanceHost) {
      throw new PreviewError('forbidden', 'caller host does not match invite target');
    }
    const peer = await prisma.remoteInstance.findUnique({
      where: { host: callerHost },
      select: { status: true },
    });
    if (!peer || peer.status !== 'peered') {
      throw new PreviewError('forbidden', 'caller host is not a peered instance');
    }
  }
  if (invite.remoteScope === 'specific_user') {
    if (!callerUser) {
      throw new PreviewError('forbidden', 'caller user header required');
    }
    if (callerUser !== invite.remoteUserId) {
      throw new PreviewError('forbidden', 'caller user does not match invite target');
    }
  }

  // Resolve the server. A federated invite without a serverId would be a
  // schema bug — the route already guards `remoteScope` only on
  // server-scoped invites — but the type system can't see that, so guard
  // here and surface an internal error if it ever happens.
  if (!invite.serverId) {
    throw new Error(
      `invite ${invite.id} has remoteScope=${invite.remoteScope} but no serverId`,
    );
  }
  const server = await prisma.server.findUnique({
    where: { id: invite.serverId },
    select: {
      id: true,
      ownerUserId: true,
      name: true,
      description: true,
      iconAttachmentId: true,
      federationEnabled: true,
    },
  });
  if (!server) {
    // Invite outlived its server (cascade should have deleted the invite;
    // surface as `unknown_invite` to the caller so we don't leak the gap).
    throw new PreviewError('unknown_invite', 'invite target server no longer exists');
  }

  // Defence-in-depth — even if the invite was minted while federation was
  // on, an operator could have flipped it off afterwards. Treat that the
  // same as "no longer valid": we don't want to publish metadata for a
  // server that's been pulled out of the federated graph.
  if (!server.federationEnabled) {
    throw new PreviewError(
      'invite_no_longer_valid',
      'invite target server has disabled federation',
    );
  }

  // Channel count — used by the receiving UI to show "12 channels". Per-
  // channel federation gates still apply on join, so this is an upper
  // bound, not a guarantee of visible-channel count after joining.
  const channelCount = await prisma.channel.count({
    where: { serverId: server.id },
  });

  // Owner identity — for federation, identities are `localpart@host`. The
  // host is THIS instance (the home) because the owner is local — owners
  // can only mint invites for servers they actually own here.
  const owner = await prisma.user.findUnique({
    where: { id: server.ownerUserId },
    select: { username: true },
  });
  if (!owner) {
    throw new Error(`server ${server.id} has ownerUserId ${server.ownerUserId} but no user row`);
  }

  // Inviter identity — same host as owner (local user). Falls back to the
  // owner if the inviter is missing (e.g. user deleted after creating the
  // invite); preview never returns null for these fields.
  let inviterUsername = owner.username;
  if (invite.createdById && invite.createdById !== server.ownerUserId) {
    const inviter = await prisma.user.findUnique({
      where: { id: invite.createdById },
      select: { username: true },
    });
    if (inviter) inviterUsername = inviter.username;
  }

  return {
    serverId: server.id,
    name: server.name,
    description: server.description,
    iconUrl: deriveServerIconUrl(server.iconAttachmentId, selfHost),
    ownerRemoteUserId: `${owner.username}@${selfHost}`,
    inviterRemoteUserId: `${inviterUsername}@${selfHost}`,
    channelCount,
  };
}

/**
 * Construct the public icon URL for a server. Returns null when no icon
 * has been set. Matches `FederationProfileService.deriveAvatarUrl` so
 * snapshot logic in P4-6 / P4-7 stays in sync.
 *
 * URL shape: `https://{selfHost}/api/attachments/{iconAttachmentId}`
 */
export function deriveServerIconUrl(
  iconAttachmentId: string | null,
  selfHost: string,
): string | null {
  if (!iconAttachmentId) return null;
  return `https://${selfHost}/api/attachments/${iconAttachmentId}`;
}
