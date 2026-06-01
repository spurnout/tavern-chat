/**
 * Posting verification gate (parity gap #4).
 *
 * Deterministic, operator-configured tiers checked on message create for
 * non-admin members. No AI. Throws a 403 TavernError when the member doesn't
 * satisfy the tier; returns normally otherwise.
 */

import { prisma } from '@tavern/db';
import { TavernError } from '@tavern/shared';

export async function assertCanPostUnderVerification(
  serverId: string,
  userId: string,
): Promise<void> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { verificationLevel: true, verificationMinAccountAgeHours: true },
  });
  if (!server || server.verificationLevel === 'none') return;

  if (server.verificationLevel === 'email_verified') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) {
      throw new TavernError(
        'VERIFICATION_REQUIRED',
        'Verify your email before posting in this tavern',
        403,
      );
    }
    return;
  }

  if (server.verificationLevel === 'account_age') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    const minMs = server.verificationMinAccountAgeHours * 60 * 60 * 1000;
    if (!user || Date.now() - user.createdAt.getTime() < minMs) {
      throw new TavernError(
        'VERIFICATION_REQUIRED',
        'Your account is too new to post in this tavern yet',
        403,
      );
    }
    return;
  }

  if (server.verificationLevel === 'must_pass_gate') {
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
      select: { gatePassedAt: true },
    });
    if (!member?.gatePassedAt) {
      throw new TavernError(
        'VERIFICATION_REQUIRED',
        'You need to be approved before posting in this tavern',
        403,
      );
    }
  }
}
