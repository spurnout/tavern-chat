/**
 * Federation Phase 4 — production `ResolveRemoteUserFn` adapter.
 *
 * `FederationMirrorService` is decoupled from the profile fetcher via a
 * `resolveRemoteUser(remoteUserId, tx)` callback: cache hit returns the
 * `RemoteUser` row; cache miss does a profile fetch and re-reads. The mirror
 * service deliberately doesn't import `FederationProfileService` directly —
 * `federation-profile.ts` is a high-level orchestrator that owns its own
 * Prisma client, and pulling it into the lifecycle helper would create a
 * circular dependency.
 *
 * This adapter is the production wiring of that callback: it tries
 * `tx.remoteUser.findUnique` first (uses the surrounding transaction so a
 * row inserted earlier in the same transaction is visible), and on miss
 * delegates to `FederationProfileService.fetchRemoteProfile`, which runs on
 * the global Prisma client (network fetch + cache upsert). The upsert
 * commits OUTSIDE the parent transaction; under read-committed isolation
 * (Postgres default) it is then visible to the subsequent `tx.remoteUser
 * .findUnique` re-read.
 *
 * Why a per-request factory instead of a method on the profile service:
 * `FederationMirrorService` takes the callback at construction time, and
 * the accept route builds one mirror service per request. Producing the
 * callback here keeps the lifecycle helper test-only when we want a stubbed
 * resolver (federation-mirror.test.ts) and uses the real profile fetcher in
 * the route.
 */

import type { RemoteUser } from '@prisma/client';
import type { ResolveRemoteUserFn } from './federation-mirror.js';
import type { FederationProfileService } from './federation-profile.js';

/**
 * Build a production `ResolveRemoteUserFn` that delegates to
 * `FederationProfileService.fetchRemoteProfile` on cache miss.
 */
export function makeProfileBackedRemoteUserResolver(
  profile: FederationProfileService,
): ResolveRemoteUserFn {
  return async (remoteUserId: string, tx): Promise<RemoteUser> => {
    // Fast path: the row is already in the cache, including any insert made
    // earlier in the same transaction.
    const existing = await tx.remoteUser.findUnique({ where: { remoteUserId } });
    if (existing) return existing;

    // Cache miss — fetch the remote profile. This runs on the global Prisma
    // client (not the tx), opens a fresh outbound HTTPS request, and upserts
    // the RemoteUser row on success.
    await profile.fetchRemoteProfile(remoteUserId);

    // Re-read via the transaction. Under Postgres' read-committed default
    // the committed upsert is visible to the current statement. If a peer
    // misbehaved and the upsert silently produced nothing, surface as a
    // hard error so the surrounding transaction rolls back.
    const fresh = await tx.remoteUser.findUnique({ where: { remoteUserId } });
    if (!fresh) {
      throw new Error(
        `resolveRemoteUser: RemoteUser ${remoteUserId} missing after fetchRemoteProfile`,
      );
    }
    return fresh;
  };
}
