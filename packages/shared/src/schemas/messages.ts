import { z } from 'zod';
import { idSchema } from './ids.js';
import { diceTermResultSchema } from './dice.js';
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
  /**
   * Inline dice-roll payload. Non-null when this message represents a
   * server-side roll (`type === 'dice_roll'`); carries the per-die breakdown
   * and total so renderers don't need a second round-trip to fetch the
   * result. Mirrors the shape stored in `DiceRoll.resultJson` plus the
   * top-level `label`.
   */
  diceRoll: z
    .object({
      notation: z.string(),
      terms: z.array(diceTermResultSchema),
      total: z.number().int(),
      label: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** Non-null when this message has an associated poll (Phase 3.2). */
  pollId: idSchema.nullable().optional(),
  /** Non-null when this message lives inside a thread (Phase 3.1). */
  threadId: idSchema.nullable().optional(),
  /** True when this message is itself the root of a thread (Phase 3.1). */
  isThreadRoot: z.boolean().optional(),
  /**
   * Set on thread-root messages so the chat view can render a clickable
   * thread footer (reply count + last activity) without a second round-trip.
   * Null/absent on non-root messages and on a freshly-created root before
   * any replies exist.
   */
  threadSummary: z
    .object({
      threadId: idSchema,
      replyCount: z.number().int().nonnegative(),
      lastActivityAt: z.string().datetime(),
    })
    .nullable()
    .optional(),
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

export const createMessageRequestSchema = z
  .object({
    content: z.string().max(MESSAGE_LIMITS.MAX_CONTENT_LENGTH),
    replyToMessageId: idSchema.optional(),
    attachmentIds: z.array(idSchema).max(MESSAGE_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    /** Idempotency key — server returns the same message id on retry. */
    nonce: z.string().min(1).max(64).optional(),
    /** Wave 2 #5 — when set, this message is a forward of an existing one. */
    forwardedFromMessageId: idSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // A message must carry SOMETHING: non-empty text, one or more attachments,
    // or a forward source (which embeds the original content). Forum threads
    // and DMs both pass through this gate, so the empty-thread title case is
    // unreachable too.
    const hasText = data.content.trim().length > 0;
    const hasAttachments = (data.attachmentIds?.length ?? 0) > 0;
    const isForward = Boolean(data.forwardedFromMessageId);
    if (!hasText && !hasAttachments && !isForward) {
      ctx.addIssue({
        code: 'custom',
        message: 'Message must have content, an attachment, or be a forward',
        path: ['content'],
      });
    }
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
