/**
 * Convert Prisma row shapes to wire-shaped DTOs.
 * Keeps Date->ISO and Decimal->string conversions in one place.
 */

import { z } from 'zod';
import type { Prisma } from '@tavern/db';
import type { StorageBackend } from '@tavern/media';
import {
  socialLinkSchema,
  type Attachment,
  type Channel as ChannelDto,
  type DiceRollResult,
  type Member,
  type Message,
  type MutualServer,
  type Reaction,
  type Role as RoleDto,
  type Server as ServerDto,
  type SocialLink,
  type UserProfile,
} from '@tavern/shared';

export function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function isoOrNow(d: Date | null | undefined): string {
  return (d ?? new Date()).toISOString();
}

interface ServerRow {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  iconAttachmentId: string | null;
  /**
   * Resolved public icon URL. Maintained on write (local icon set / scan-ready)
   * or stored from the home (mirrors). Optional on the row shape because some
   * legacy queries don't select it yet; treated as null when absent.
   */
  iconUrl?: string | null;
  defaultRoleId: string | null;
  /** P3-10 — per-Tavern federation opt-in. */
  federationEnabled: boolean;
  /**
   * P4-16 — mirror provenance. Null on locally-owned servers; non-null on
   * mirrors, pointing at `RemoteInstance.id`. Optional on the row shape
   * because some legacy queries (existing tests, older route handlers) don't
   * pull this column yet; the serializer treats `undefined` the same as
   * `null` (locally-owned).
   */
  originInstanceId?: string | null;
  /**
   * P4-16 — resolved origin host. Set by callers that fetch the Server with
   * `include: { originInstance: { select: { host: true } } }`. Pass a bare
   * string here and the serializer threads it through; pass undefined and we
   * default to null (the wire schema's nullable default).
   */
  originInstance?: { host: string } | null;
  createdAt: Date;
}

export function serializeServer(row: ServerRow): ServerDto {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    description: row.description,
    iconAttachmentId: row.iconAttachmentId,
    iconUrl: row.iconUrl ?? null,
    defaultRoleId: row.defaultRoleId ?? '',
    federationEnabled: row.federationEnabled,
    originInstanceId: row.originInstanceId ?? null,
    originInstanceHost: row.originInstance?.host ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

interface ChannelRow {
  id: string;
  serverId: string;
  parentId: string | null;
  campaignId: string | null;
  gameNightId: string | null;
  type: string;
  name: string;
  topic: string | null;
  position: number;
  nsfw: boolean;
  videoEnabled: boolean;
  /** P3-11 — per-channel federation override. */
  federationMode: 'inherit' | 'force_on' | 'force_off';
  createdAt: Date;
}

export function serializeChannel(row: ChannelRow): ChannelDto {
  return {
    id: row.id,
    serverId: row.serverId,
    parentId: row.parentId,
    campaignId: row.campaignId,
    gameNightId: row.gameNightId,
    type: row.type as ChannelDto['type'],
    name: row.name,
    topic: row.topic,
    position: row.position,
    nsfw: row.nsfw,
    videoEnabled: row.videoEnabled,
    federationMode: row.federationMode,
    createdAt: row.createdAt.toISOString(),
  };
}

interface RoleRow {
  id: string;
  serverId: string;
  name: string;
  color: number;
  position: number;
  permissions: Prisma.Decimal;
  mentionable: boolean;
  hoist: boolean;
  isEveryone: boolean;
}

export function serializeRole(row: RoleRow): RoleDto {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    color: row.color,
    position: row.position,
    permissions: row.permissions.toString(),
    mentionable: row.mentionable,
    hoist: row.hoist,
    isEveryone: row.isEveryone,
  };
}

interface MemberRow {
  serverId: string;
  userId: string;
  nickname: string | null;
  joinedAt: Date;
  timeoutUntil: Date | null;
  roles: { roleId: string }[];
  user: { id: string; displayName: string; username: string; presence?: string };
}

export function serializeMember(row: MemberRow): Member {
  return {
    serverId: row.serverId,
    userId: row.userId,
    user: {
      id: row.user.id,
      displayName: row.user.displayName,
      username: row.user.username,
      presence: (row.user.presence as Member['user']['presence']) ?? 'offline',
    },
    nickname: row.nickname,
    joinedAt: row.joinedAt.toISOString(),
    timeoutUntil: row.timeoutUntil ? row.timeoutUntil.toISOString() : null,
    roles: row.roles.map((r) => r.roleId),
  };
}

const socialLinksArraySchema = z.array(socialLinkSchema);

/**
 * Coerce a Prisma jsonb column into a typed SocialLink[]. Invalid shapes
 * fall back to an empty array so a broken row never crashes the API.
 * Writes are validated by the zod schema on the way in.
 */
export function parseSocialLinks(value: unknown): SocialLink[] {
  const result = socialLinksArraySchema.safeParse(value);
  return result.success ? result.data : [];
}

interface UserProfileRow {
  id: string;
  username: string;
  displayName: string;
  avatarAttachmentId: string | null;
  bio: string | null;
  presence: string;
  createdAt: Date;
  pronouns: string | null;
  accentColor: string | null;
  timezone: string | null;
  customStatus: string | null;
  customStatusExpiresAt: Date | null;
  socialLinks: Prisma.JsonValue;
}

export function serializeUserProfile(
  row: UserProfileRow,
  mutualServers: MutualServer[] = [],
): UserProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarAttachmentId: row.avatarAttachmentId,
    bio: row.bio,
    presence: row.presence as UserProfile['presence'],
    createdAt: row.createdAt.toISOString(),
    pronouns: row.pronouns,
    accentColor: row.accentColor,
    timezone: row.timezone,
    customStatus: row.customStatus,
    customStatusExpiresAt: row.customStatusExpiresAt
      ? row.customStatusExpiresAt.toISOString()
      : null,
    socialLinks: parseSocialLinks(row.socialLinks),
    mutualServers,
  };
}

export interface AttachmentRow {
  id: string;
  uploaderId: string;
  serverId: string | null;
  channelId: string | null;
  messageId: string | null;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: bigint;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[];
  status: string;
  createdAt: Date;
  storageBucket: string;
  storageKey: string;
  thumbnailKey: string | null;
}

export function serializeAttachment(row: AttachmentRow, storage: StorageBackend): Attachment {
  const url = row.status === 'ready' ? storage.getPublicUrl(row.storageBucket, row.storageKey) : null;
  const thumbnailUrl =
    row.status === 'ready' && row.thumbnailKey
      ? storage.getPublicUrl(row.storageBucket, row.thumbnailKey)
      : null;
  return {
    id: row.id,
    uploaderId: row.uploaderId,
    serverId: row.serverId,
    channelId: row.channelId,
    messageId: row.messageId,
    kind: row.kind as Attachment['kind'],
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    waveform: row.waveform.length > 0 ? row.waveform : null,
    thumbnailUrl,
    url,
    status: row.status as Attachment['status'],
    createdAt: row.createdAt.toISOString(),
  };
}

export interface MessageRow {
  id: string;
  serverId: string | null;
  channelId: string | null;
  dmChannelId: string | null;
  authorId: string;
  type: string;
  content: string;
  replyToMessageId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  safetyState: string;
  diceRollId: string | null;
  /**
   * Optional inline dice-roll result. Populated when the message query
   * includes the `diceRoll` relation with at least `resultJson` and `label`
   * selected. `resultJson` is `Prisma.JsonValue` at the storage layer but
   * always matches `DiceRollResult` shape — we wrote it through that schema
   * in the dice / slash routes.
   */
  diceRoll?: {
    resultJson: unknown;
    label: string | null;
  } | null;
  /** Phase 3.1 — thread membership. */
  threadId?: string | null;
  isThreadRoot?: boolean;
  /**
   * Pre-computed thread footer payload for root messages. Callers are
   * responsible for setting this when `isThreadRoot` is true (batch via
   * `loadThreadSummariesForRootIds` in list endpoints, single fetch in edit
   * paths). When omitted on a root, the wire field is null and the client
   * still shows a "View thread" affordance based on `isThreadRoot` alone.
   */
  threadSummary?: {
    threadId: string;
    replyCount: number;
    lastActivityAt: Date;
  } | null;
  /** Wave 2 #5 — forwarded-from provenance. */
  forwardedFromMessageId?: string | null;
  forwardedFromChannelId?: string | null;
  createdAt: Date;
  attachments: { id: string }[];
  reactions: { emoji: string; userId: string }[];
  author: { id: string; displayName: string; username: string };
  /** Phase 3.2 — when the message has a poll attached, the include returns
   * `poll: { id }` (or null). */
  poll?: { id: string } | null;
  /** Wave 2 #2 — parent message preview when replyToMessageId is set. */
  replyTo?: {
    id: string;
    content: string;
    deletedAt: Date | null;
    author: { displayName: string };
  } | null;
  /** Wave 2 #5 — forwarded-from message preview. */
  forwardedFrom?: {
    id: string;
    channelId: string | null;
    author: { displayName: string };
  } | null;
}

export function serializeMessage(row: MessageRow, viewerId: string): Message {
  const reactionByEmoji = new Map<string, { count: number; me: boolean }>();
  for (const r of row.reactions) {
    const entry = reactionByEmoji.get(r.emoji) ?? { count: 0, me: false };
    entry.count += 1;
    if (r.userId === viewerId) entry.me = true;
    reactionByEmoji.set(r.emoji, entry);
  }
  const reactions: Reaction extends never ? never[] : Message['reactions'] = Array.from(
    reactionByEmoji.entries(),
  ).map(([emoji, v]) => ({ emoji, count: v.count, me: v.me }));

  return {
    id: row.id,
    serverId: row.serverId,
    channelId: row.channelId,
    dmChannelId: row.dmChannelId,
    authorId: row.authorId,
    author: {
      id: row.author.id,
      displayName: row.author.displayName,
      username: row.author.username,
    },
    type: row.type as Message['type'],
    content: row.deletedAt ? '' : row.content,
    replyToMessageId: row.replyToMessageId,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    safetyState: row.safetyState as Message['safetyState'],
    attachmentIds: row.attachments.map((a) => a.id),
    reactions,
    diceRollId: row.diceRollId,
    diceRoll: row.diceRoll
      ? (() => {
          // `resultJson` was written through `diceRollResultSchema` in the
          // dice/slash routes, so the shape is trusted. Cast rather than
          // re-parse to keep the hot serializer cheap; if a future migration
          // ever changes the stored shape, the renderer will simply skip
          // unknown fields.
          const r = row.diceRoll.resultJson as DiceRollResult;
          return {
            notation: r.notation,
            terms: r.terms,
            total: r.total,
            label: row.diceRoll.label,
          };
        })()
      : null,
    pollId: row.poll?.id ?? null,
    threadId: row.threadId ?? null,
    isThreadRoot: row.isThreadRoot ?? false,
    threadSummary: row.threadSummary
      ? {
          threadId: row.threadSummary.threadId,
          replyCount: row.threadSummary.replyCount,
          lastActivityAt: row.threadSummary.lastActivityAt.toISOString(),
        }
      : null,
    replyTo: row.replyTo
      ? {
          id: row.replyTo.id,
          authorDisplayName: row.replyTo.author.displayName,
          contentExcerpt: excerpt(row.replyTo.deletedAt ? '' : row.replyTo.content),
          deleted: !!row.replyTo.deletedAt,
        }
      : null,
    forwardedFrom: row.forwardedFrom
      ? {
          messageId: row.forwardedFrom.id,
          channelId: row.forwardedFrom.channelId,
          authorDisplayName: row.forwardedFrom.author.displayName,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function excerpt(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 80)}…`;
}
