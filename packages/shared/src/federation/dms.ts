import { z } from 'zod';

// NOTE: REMOTE_USER_ID_RE is duplicated across messages.ts and membership.ts.
// Follow-up #18 tracks consolidating these into a shared helper; until then we
// keep the duplication local to each federation schema module.
const REMOTE_USER_ID_RE = /^[a-z0-9_.-]+@[a-z0-9.-]+\.[a-z0-9.-]+$/i;

const remoteUserIdSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(REMOTE_USER_ID_RE, 'expected localpart@host');

// DM channel and message ids are ULIDs locally but kept opaque on the wire so
// the receiving instance can map them to its own row ids. Mirrors the pattern
// in messages.ts.
const idSchema = z.string().min(1).max(64);

// DM creation: a remote instance announces that one of its users has opened
// a DM with one of our users (or, when sent A -> B, vice versa). The
// dmChannelId is the originating instance's id; receivers map it to their own
// DM channel row.
export const dmCreatePayloadSchema = z.object({
  dmChannelId: idSchema,
  initiatorRemoteUserId: remoteUserIdSchema,
  recipientRemoteUserId: remoteUserIdSchema,
  createdAt: z.string().datetime(),
});

// DM message create. Content cap mirrors messages.ts (8192 federation envelope
// limit; local MAX_MESSAGE_LENGTH still re-applied after parse).
export const dmMessageCreatePayloadSchema = z.object({
  dmChannelId: idSchema,
  messageId: idSchema,
  authorRemoteUserId: remoteUserIdSchema,
  content: z.string().max(8192),
  replyToMessageId: idSchema.nullable().optional(),
  createdAt: z.string().datetime(),
});

export const dmMessageUpdatePayloadSchema = z.object({
  dmChannelId: idSchema,
  messageId: idSchema,
  authorRemoteUserId: remoteUserIdSchema,
  content: z.string().max(8192),
  editedAt: z.string().datetime(),
});

export const dmMessageDeletePayloadSchema = z.object({
  dmChannelId: idSchema,
  messageId: idSchema,
  actorRemoteUserId: remoteUserIdSchema,
  deletedAt: z.string().datetime(),
});

export const dmReactionAddPayloadSchema = z.object({
  dmChannelId: idSchema,
  messageId: idSchema,
  actorRemoteUserId: remoteUserIdSchema,
  emoji: z.string().min(1).max(64),
});

export const dmReactionRemovePayloadSchema = z.object({
  dmChannelId: idSchema,
  messageId: idSchema,
  actorRemoteUserId: remoteUserIdSchema,
  emoji: z.string().min(1).max(64),
});

export type DmCreatePayload = z.infer<typeof dmCreatePayloadSchema>;
export type DmMessageCreatePayload = z.infer<typeof dmMessageCreatePayloadSchema>;
export type DmMessageUpdatePayload = z.infer<typeof dmMessageUpdatePayloadSchema>;
export type DmMessageDeletePayload = z.infer<typeof dmMessageDeletePayloadSchema>;
export type DmReactionAddPayload = z.infer<typeof dmReactionAddPayloadSchema>;
export type DmReactionRemovePayload = z.infer<typeof dmReactionRemovePayloadSchema>;
