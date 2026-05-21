import { z } from 'zod';
import { idSchema } from '../schemas/ids.js';
import { NAME_LIMITS } from '../constants.js';

const REMOTE_USER_ID_RE = /^[a-z0-9_.-]+@[a-z0-9.-]+\.[a-z0-9.-]+$/i;
export const remoteUserIdSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(REMOTE_USER_ID_RE, 'expected localpart@host');

// B -> A: alice@b wants to join Tavern T (with serverId), using invite code C.
export const memberJoinRequestPayloadSchema = z.object({
  inviteCode: z.string().min(4).max(64),
  joinerRemoteUserId: remoteUserIdSchema,
});

// A -> B: confirmation + initial snapshot.
export const serverSnapshotSchema = z.object({
  serverId: idSchema,
  ownerRemoteUserId: remoteUserIdSchema,
  name: z.string().min(1).max(NAME_LIMITS.MAX_SERVER_NAME),
  description: z.string().max(NAME_LIMITS.MAX_DESCRIPTION).nullable(),
  iconUrl: z.string().url().nullable(),
  federationEnabled: z.literal(true),
  channels: z.array(
    z.object({
      id: idSchema,
      name: z.string().min(1).max(NAME_LIMITS.MAX_CHANNEL_NAME),
      type: z.enum(['text', 'forum']),
      topic: z.string().max(NAME_LIMITS.MAX_TOPIC).nullable(),
      position: z.number().int().min(0),
      federationMode: z.enum(['inherit', 'force_on', 'force_off']).default('inherit'),
      nsfw: z.boolean().default(false),
    }),
  ),
  members: z.array(
    z.object({
      remoteUserId: remoteUserIdSchema,
      displayName: z.string(),
      joinedAt: z.string().datetime(),
    }),
  ),
  createdAt: z.string().datetime(),
});

export const memberJoinedPayloadSchema = z.object({
  inviteCode: z.string(),
  serverSnapshot: serverSnapshotSchema,
});

export const memberAddPayloadSchema = z.object({
  serverId: idSchema,
  memberRemoteUserId: remoteUserIdSchema,
  memberDisplayName: z.string(),
  joinedAt: z.string().datetime(),
});

export const memberRemovePayloadSchema = z.object({
  serverId: idSchema,
  memberRemoteUserId: remoteUserIdSchema,
  reason: z.enum(['kicked', 'banned', 'left']),
  removedAt: z.string().datetime(),
});

export const memberLeavePayloadSchema = z.object({
  serverId: idSchema,
  leaverRemoteUserId: remoteUserIdSchema,
  leftAt: z.string().datetime(),
});

export const memberRemovedPayloadSchema = z.object({
  serverId: idSchema,
  leaverRemoteUserId: remoteUserIdSchema,
});

export type MemberJoinRequestPayload = z.infer<typeof memberJoinRequestPayloadSchema>;
export type ServerSnapshot = z.infer<typeof serverSnapshotSchema>;
export type MemberJoinedPayload = z.infer<typeof memberJoinedPayloadSchema>;
export type MemberAddPayload = z.infer<typeof memberAddPayloadSchema>;
export type MemberRemovePayload = z.infer<typeof memberRemovePayloadSchema>;
export type MemberLeavePayload = z.infer<typeof memberLeavePayloadSchema>;
export type MemberRemovedPayload = z.infer<typeof memberRemovedPayloadSchema>;
