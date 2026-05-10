/**
 * Convert Prisma row shapes to wire-shaped DTOs.
 * Keeps Date->ISO and Decimal->string conversions in one place.
 */

import type { Prisma } from '@tavern/db';
import type {
  Attachment,
  Channel as ChannelDto,
  Member,
  Message,
  Reaction,
  Role as RoleDto,
  Server as ServerDto,
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
  defaultRoleId: string | null;
  createdAt: Date;
}

export function serializeServer(row: ServerRow): ServerDto {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    description: row.description,
    iconAttachmentId: row.iconAttachmentId,
    defaultRoleId: row.defaultRoleId ?? '',
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
}

export function serializeMember(row: MemberRow): Member {
  return {
    serverId: row.serverId,
    userId: row.userId,
    nickname: row.nickname,
    joinedAt: row.joinedAt.toISOString(),
    timeoutUntil: row.timeoutUntil ? row.timeoutUntil.toISOString() : null,
    roles: row.roles.map((r) => r.roleId),
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

export function serializeAttachment(row: AttachmentRow, publicBaseUrl: string): Attachment {
  const url = row.status === 'ready' ? `${publicBaseUrl}/${row.storageKey}` : null;
  const thumbnailUrl =
    row.status === 'ready' && row.thumbnailKey ? `${publicBaseUrl}/${row.thumbnailKey}` : null;
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
  serverId: string;
  channelId: string;
  authorId: string;
  type: string;
  content: string;
  replyToMessageId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  safetyState: string;
  diceRollId: string | null;
  createdAt: Date;
  attachments: { id: string }[];
  reactions: { emoji: string; userId: string }[];
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
    authorId: row.authorId,
    type: row.type as Message['type'],
    content: row.deletedAt ? '' : row.content,
    replyToMessageId: row.replyToMessageId,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    safetyState: row.safetyState as Message['safetyState'],
    attachmentIds: row.attachments.map((a) => a.id),
    reactions,
    diceRollId: row.diceRollId,
    createdAt: row.createdAt.toISOString(),
  };
}
