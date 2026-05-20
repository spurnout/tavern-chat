import type { Prisma, PrismaClient } from '@prisma/client';
import { hasGroupMention, nameMentions, qualifiedMentions, type ParsedMention, ulid } from '@tavern/shared';
import type { FederationProfileService } from './federation-profile.js';

/**
 * Resolve a list of parsed mentions to the concrete recipient userIds.
 * The author is always excluded — you cannot mention yourself.
 *
 * - `@everyone` → all server members visible in the channel (excluding author)
 * - `@here` → server members with presence in (active, idle), excluding author
 * - `@<name>` → first try server role by name (mentioned = all role holders),
 *               then server member by displayName or username
 *
 * Each recipient gets at most one UserMention per message; the `kind` is
 * chosen by the strongest match (everyone > here > role > user).
 *
 * Visibility note: we don't currently filter by channel-level overwrite
 * deny. The mention still resolves and the recipient sees it in their inbox,
 * but they can't open the message if VIEW_CHANNEL is denied. That's the
 * same trade-off the rest of the codebase makes for fanout.
 */

interface ResolveInput {
  tx: Prisma.TransactionClient | PrismaClient;
  parsed: ReadonlyArray<ParsedMention>;
  serverId: string;
  authorId: string;
}

type MentionKindLiteral = 'user' | 'role' | 'everyone' | 'here';

interface ResolvedRecipient {
  userId: string;
  kind: MentionKindLiteral;
}

export async function resolveMentionRecipients({
  tx,
  parsed,
  serverId,
  authorId,
}: ResolveInput): Promise<ResolvedRecipient[]> {
  if (parsed.length === 0) return [];

  const byUserId = new Map<string, MentionKindLiteral>();
  const promote = (userId: string, kind: MentionKindLiteral): void => {
    if (userId === authorId) return;
    const existing = byUserId.get(userId);
    if (!existing) {
      byUserId.set(userId, kind);
      return;
    }
    const rank: Record<MentionKindLiteral, number> = {
      everyone: 4,
      here: 3,
      role: 2,
      user: 1,
    };
    if (rank[kind] > rank[existing]) byUserId.set(userId, kind);
  };

  const wantsEveryone = parsed.some((m) => m.kind === 'group' && m.group === 'everyone');
  const wantsHere = parsed.some((m) => m.kind === 'group' && m.group === 'here');

  if (wantsEveryone) {
    const members = await tx.serverMember.findMany({
      where: { serverId },
      select: { userId: true },
    });
    for (const m of members) promote(m.userId, 'everyone');
  }
  if (wantsHere) {
    const members = await tx.serverMember.findMany({
      where: { serverId, user: { presence: { in: ['active', 'idle'] } } },
      select: { userId: true },
    });
    for (const m of members) promote(m.userId, 'here');
  }

  const names = nameMentions(parsed);
  if (names.length > 0) {
    const roles = await tx.role.findMany({
      where: { serverId, name: { in: names } },
      include: {
        memberAssignments: { select: { userId: true } },
      },
    });
    for (const role of roles) {
      for (const a of role.memberAssignments) promote(a.userId, 'role');
    }

    // Anything that didn't match a role — try a member by displayName / username.
    const matchedRoleNames = new Set(roles.map((r) => r.name));
    const userNameCandidates = names.filter((n) => !matchedRoleNames.has(n));
    if (userNameCandidates.length > 0) {
      const members = await tx.serverMember.findMany({
        where: {
          serverId,
          user: {
            OR: [
              { displayName: { in: userNameCandidates } },
              { username: { in: userNameCandidates } },
            ],
          },
        },
        select: { userId: true },
      });
      for (const m of members) promote(m.userId, 'user');
    }
  }

  return Array.from(byUserId.entries()).map(([userId, kind]) => ({ userId, kind }));
}

interface WriteInput {
  tx: Prisma.TransactionClient;
  recipients: ReadonlyArray<ResolvedRecipient>;
  messageId: string;
  channelId: string | null;
  dmChannelId: string | null;
}

/**
 * Insert UserMention rows + bump UserChannelReadState.mentionCount for each
 * recipient. Called inside the same transaction as the message insert so
 * a write failure rolls the whole post back.
 */
export async function writeMentionRecords({
  tx,
  recipients,
  messageId,
  channelId,
  dmChannelId,
}: WriteInput): Promise<void> {
  if (recipients.length === 0) return;

  await tx.userMention.createMany({
    data: recipients.map((r) => ({
      id: ulid(),
      userId: r.userId,
      messageId,
      channelId,
      dmChannelId,
      kind: r.kind,
    })),
    skipDuplicates: true,
  });

  if (channelId) {
    // Upsert per-(user, channel) read state and increment the cached count.
    // Sequential because Prisma's batched upsert isn't yet available; the
    // recipient set is typically small.
    for (const r of recipients) {
      await tx.userChannelReadState.upsert({
        where: { userId_channelId: { userId: r.userId, channelId } },
        create: {
          userId: r.userId,
          channelId,
          mentionCount: 1,
        },
        update: {
          mentionCount: { increment: 1 },
        },
      });
    }
  }
}

export { hasGroupMention };

/**
 * Kick off best-effort profile lookups for any qualified mentions
 * (e.g. `@alice@b.example`) found in the message text.
 *
 * This is fire-and-forget: the function returns immediately and any
 * individual fetch failure is caught and logged rather than propagated.
 * Message creation is NOT blocked by federation round-trips.
 *
 * When `federationProfile` is absent (federation disabled) this is a no-op.
 */
export function resolveQualifiedMentionsAsync(
  text: string,
  federationProfile: FederationProfileService | null | undefined,
  logger?: { warn: (obj: object, msg: string) => void },
): void {
  if (!federationProfile) return;
  const targets = qualifiedMentions(text);
  if (targets.length === 0) return;

  const unique = new Set(targets.map((t) => `${t.localpart}@${t.host}`));
  for (const remoteUserId of unique) {
    federationProfile.fetchRemoteProfile(remoteUserId).catch((err: unknown) => {
      logger?.warn({ err, remoteUserId }, 'failed to resolve qualified mention');
    });
  }
}
