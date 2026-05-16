import { z } from 'zod';
import { idSchema } from './ids.js';
import { MESSAGE_LIMITS } from '../constants.js';

export const messageTypeSchema = z.enum([
  'default',
  'system',
  'voice',
  'dice_roll',
  'session_event',
]);

export const safetyStateSchema = z.enum([
  'allowed',
  'labeled',
  'warning',
  'blurred',
  'held',
  'quarantined',
  'blocked',
]);

export const messageAuthorSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  username: z.string(),
});

export const messageSchema = z.object({
  id: idSchema,
  /** Non-null for server messages, null for DM messages. */
  serverId: idSchema.nullable(),
  /** Non-null for server messages, null for DM messages. */
  channelId: idSchema.nullable(),
  /** Non-null for DM messages, null for server messages. */
  dmChannelId: idSchema.nullable(),
  authorId: idSchema,
  author: messageAuthorSchema,
  type: messageTypeSchema,
  content: z.string(),
  replyToMessageId: idSchema.nullable(),
  editedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  safetyState: safetyStateSchema,
  attachmentIds: z.array(idSchema),
  reactions: z.array(
    z.object({
      emoji: z.string(),
      count: z.number().int().nonnegative(),
      me: z.boolean(),
    }),
  ),
  diceRollId: idSchema.nullable(),
  /** Non-null when this message has an associated poll (Phase 3.2). */
  pollId: idSchema.nullable().optional(),
  /** Non-null when this message lives inside a thread (Phase 3.1). */
  threadId: idSchema.nullable().optional(),
  /** True when this message is itself the root of a thread (Phase 3.1). */
  isThreadRoot: z.boolean().optional(),
  /** Wave 2 #2 — inline preview of the parent message when this is a reply. */
  replyTo: z
    .object({
      id: idSchema,
      authorDisplayName: z.string(),
      contentExcerpt: z.string(),
      deleted: z.boolean(),
    })
    .nullable()
    .optional(),
  /** Wave 2 #5 — forwarded-message provenance. */
  forwardedFrom: z
    .object({
      messageId: idSchema,
      channelId: idSchema.nullable(),
      authorDisplayName: z.string(),
    })
    .nullable()
    .optional(),
  createdAt: z.string().datetime(),
});

export const createMessageRequestSchema = z.object({
  content: z.string().max(MESSAGE_LIMITS.MAX_CONTENT_LENGTH),
  replyToMessageId: idSchema.optional(),
  attachmentIds: z.array(idSchema).max(MESSAGE_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  /** Idempotency key — server returns the same message id on retry. */
  nonce: z.string().min(1).max(64).optional(),
  /** Wave 2 #5 — when set, this message is a forward of an existing one. */
  forwardedFromMessageId: idSchema.optional(),
});

export const updateMessageRequestSchema = z.object({
  content: z.string().max(MESSAGE_LIMITS.MAX_CONTENT_LENGTH),
});

export const listMessagesQuerySchema = z.object({
  before: idSchema.optional(),
  after: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type MessageType = z.infer<typeof messageTypeSchema>;
export type SafetyState = z.infer<typeof safetyStateSchema>;
export type Message = z.infer<typeof messageSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
export type UpdateMessageRequest = z.infer<typeof updateMessageRequestSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
