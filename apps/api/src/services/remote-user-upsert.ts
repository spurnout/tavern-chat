/**
 * Federation Phase 3 — represent remote users as local User rows.
 *
 * Once messages start federating, every inbound message has an `authorId` that
 * must be a real `User.id` (FK), and every mention/reaction/audit-log entry
 * resolves through the User table. To avoid carrying a parallel "is this a
 * remote user?" check on every join, Phase 3 materializes each `RemoteUser`
 * we hear from as a User row with:
 *
 *   - synthetic, collision-proof username + email (so the existing UNIQUE
 *     constraints don't conflict with any local account),
 *   - `passwordHash = null` (the auth-service login/reset/change paths reject
 *     any User where this is null — see auth-service.ts lines 390, 719, 776),
 *   - the home instance + qualified remote id back-reference,
 *   - a copy of the cached public key, so signature verification can read it
 *     straight off `User.federationKeyPublic` without a second lookup.
 *
 * The function is idempotent and concurrency-safe: two inbound message
 * handlers can call it in parallel for the same RemoteUser without producing
 * duplicate rows. The `User.remoteUserId @unique` constraint is the source
 * of truth; a P2002 race surfaces here as a re-fetch of whichever side won.
 */

import { Prisma, type PrismaClient, type RemoteUser, type User } from '@prisma/client';
import { prisma as defaultPrisma } from '@tavern/db';
import { ulid } from '@tavern/shared';

/**
 * Returns the User row that represents `remoteUser` on this instance. If a
 * User with `remoteUserId === remoteUser.remoteUserId` already exists, it is
 * returned unchanged. Otherwise a new User row is created with the synthetic
 * local identifiers documented above and returned.
 *
 * The `prisma` argument is optional for ergonomics — production callers can
 * omit it and pick up the shared singleton; tests inject their own client.
 */
export async function ensureUserForRemoteUser(
  remoteUser: RemoteUser,
  prisma: PrismaClient = defaultPrisma,
): Promise<User> {
  // Fast path: already materialised.
  const existing = await prisma.user.findUnique({
    where: { remoteUserId: remoteUser.remoteUserId },
  });
  if (existing) return existing;

  const newUserId = ulid();
  const usernameSeed = ulid().toLowerCase();
  const username = `__rem_${usernameSeed}`;
  // Defensive lowercase: the synthetic email is built from the qualified
  // remoteUserId, which by RFC convention is already lower-case in the
  // localpart, but we re-fold here so a misbehaving peer can't slip a
  // mixed-case row past the UNIQUE(emailLower) check.
  const baseEmail = `${remoteUser.remoteUserId}.federated.local`;
  const email = baseEmail;
  const emailLower = baseEmail.toLowerCase();

  try {
    return await prisma.user.create({
      data: {
        id: newUserId,
        username,
        usernameLower: username, // synthetic ulid is already lower-case
        displayName: remoteUser.displayNameCache,
        email,
        emailLower,
        passwordHash: null,
        remoteUserId: remoteUser.remoteUserId,
        remoteInstanceId: remoteUser.remoteInstanceId,
        // Prisma represents Bytes as Buffer in TS — wrap defensively in case
        // the source row's bytes came in as a Uint8Array view.
        federationKeyPublic: Buffer.from(remoteUser.publicKey),
      },
    });
  } catch (err) {
    // Race recovery: another inbound handler raced us through the same code
    // path and won the unique constraint on `remoteUserId`. Re-fetch and
    // return the winner. Any other Prisma error (e.g. P2003 FK violation
    // because the RemoteInstance was deleted under us) propagates so the
    // caller can decide how to recover.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.user.findUnique({
        where: { remoteUserId: remoteUser.remoteUserId },
      });
      if (winner) return winner;
    }
    throw err;
  }
}
