import { z } from 'zod';

const REMOTE_USER_ID_RE = /^[a-z0-9_.-]+@[a-z0-9.-]+\.[a-z0-9.-]+$/i;

const remoteUserIdSchema = z.string().min(3).max(253).regex(REMOTE_USER_ID_RE, 'expected localpart@host');

// Channel and message ids are ULIDs but in federation context they may be opaque
// strings (the receiving instance maps the id it received to its own row).
// Keep validation light.
const idSchema = z.string().min(1).max(64);

// NOTE: content cap is 8192 here (federation envelope limit), which is intentionally
// larger than the local MAX_MESSAGE_LENGTH default of 4000. The local validator
// re-applies the instance's own cap after the envelope is parsed and the
// federated message is canonicalized. The federation layer keeps a generous bound
// to avoid rejecting messages from instances with a higher local cap configured.
export const messageCreatePayloadSchema = z.object({
  authorRemoteUserId: remoteUserIdSchema,
  channelId: idSchema,
  messageId: idSchema, // home instance's id; the receiving instance stores its OWN id but keeps signature + originInstanceId
  content: z.string().max(8192), // overall message length cap; existing local cap is MAX_MESSAGE_LENGTH from config
  replyToMessageId: idSchema.nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
});

export const messageUpdatePayloadSchema = z.object({
  authorRemoteUserId: remoteUserIdSchema,
  messageId: idSchema,
  content: z.string().max(8192),
  editedAt: z.string().datetime({ offset: true }),
});

export const messageDeletePayloadSchema = z.object({
  // The deleter — usually the author. Phase 7 will introduce moderator deletes.
  actorRemoteUserId: remoteUserIdSchema,
  messageId: idSchema,
  deletedAt: z.string().datetime({ offset: true }),
});

export const reactionAddPayloadSchema = z.object({
  actorRemoteUserId: remoteUserIdSchema,
  messageId: idSchema,
  // Emoji either unicode (':smile:' or '😀') or a custom-emoji reference. Keep
  // it permissive — the local instance's reaction validator runs after we
  // canonicalize.
  emoji: z.string().min(1).max(64),
});

export const reactionRemovePayloadSchema = z.object({
  actorRemoteUserId: remoteUserIdSchema,
  messageId: idSchema,
  emoji: z.string().min(1).max(64),
});

export type MessageCreatePayload = z.infer<typeof messageCreatePayloadSchema>;
export type MessageUpdatePayload = z.infer<typeof messageUpdatePayloadSchema>;
export type MessageDeletePayload = z.infer<typeof messageDeletePayloadSchema>;
export type ReactionAddPayload = z.infer<typeof reactionAddPayloadSchema>;
export type ReactionRemovePayload = z.infer<typeof reactionRemovePayloadSchema>;
