import { z } from 'zod';
import { idSchema } from './ids.js';
import { presenceSchema } from './presence.js';
import { NAME_LIMITS } from '../constants.js';

export const dmChannelKindSchema = z.enum(['direct', 'group']);

/** Slim user shape exposed inside DM channel member lists. */
export const dmChannelMemberUserSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  username: z.string(),
  presence: presenceSchema.default('offline'),
});

export const dmChannelMemberSchema = z.object({
  userId: idSchema,
  user: dmChannelMemberUserSchema,
  joinedAt: z.string().datetime(),
  /** Watermark for unread-count. Null when the user has never opened the channel. */
  lastReadAt: z.string().datetime().nullable(),
});

export const dmChannelSchema = z.object({
  id: idSchema,
  kind: dmChannelKindSchema,
  /** Group DMs may have a name; direct DMs derive theirs from the other member. */
  name: z.string().max(NAME_LIMITS.MAX_DISPLAY_NAME).nullable(),
  createdAt: z.string().datetime(),
  /** Updated server-side on every new message; used to sort the DM list. */
  lastMessageAt: z.string().datetime().nullable(),
  members: z.array(dmChannelMemberSchema),
});

/** Body of POST /api/dms/direct: open or reuse the 1:1 thread with a user. */
export const createDirectDmRequestSchema = z.object({
  userId: idSchema,
});

/** Body of POST /api/dms/group: spin up a new group thread. */
export const createGroupDmRequestSchema = z.object({
  /** Other members (the caller is added automatically). At least 2 others. */
  userIds: z.array(idSchema).min(2).max(9),
  /** Optional display name; if omitted, the UI shows a member-list summary. */
  name: z.string().min(1).max(NAME_LIMITS.MAX_DISPLAY_NAME).optional(),
});

/** Body of PATCH /api/dms/:id: rename a group (no-op for direct). */
export const updateDmChannelRequestSchema = z.object({
  name: z.string().min(1).max(NAME_LIMITS.MAX_DISPLAY_NAME).nullable(),
});

/** Mark-read body. Optional timestamp; server uses now() if omitted. */
export const markDmReadRequestSchema = z.object({
  at: z.string().datetime().optional(),
});

export const sendDmMessageRequestSchema = z.object({
  content: z.string().max(2000),
  replyToMessageId: idSchema.optional(),
  attachmentIds: z.array(idSchema).max(10).optional(),
  nonce: z.string().min(1).max(64).optional(),
});

export type DmChannelKind = z.infer<typeof dmChannelKindSchema>;
export type DmChannelMember = z.infer<typeof dmChannelMemberSchema>;
export type DmChannel = z.infer<typeof dmChannelSchema>;
export type CreateDirectDmRequest = z.infer<typeof createDirectDmRequestSchema>;
export type CreateGroupDmRequest = z.infer<typeof createGroupDmRequestSchema>;
export type UpdateDmChannelRequest = z.infer<typeof updateDmChannelRequestSchema>;
export type MarkDmReadRequest = z.infer<typeof markDmReadRequestSchema>;
export type SendDmMessageRequest = z.infer<typeof sendDmMessageRequestSchema>;
