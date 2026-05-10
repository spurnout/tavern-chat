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

export const messageSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  channelId: idSchema,
  authorId: idSchema,
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
  createdAt: z.string().datetime(),
});

export const createMessageRequestSchema = z.object({
  content: z.string().max(MESSAGE_LIMITS.MAX_CONTENT_LENGTH),
  replyToMessageId: idSchema.optional(),
  attachmentIds: z.array(idSchema).max(MESSAGE_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  /** Idempotency key — server returns the same message id on retry. */
  nonce: z.string().min(1).max(64).optional(),
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
