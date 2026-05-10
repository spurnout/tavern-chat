import { z } from 'zod';
import { idSchema } from './ids.js';

export const attachmentKindSchema = z.enum([
  'image',
  'gif',
  'video',
  'audio',
  'voice_message',
  'map',
  'handout',
  'character_asset',
  'file',
]);

export const attachmentStatusSchema = z.enum([
  'pending',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'blocked',
  'quarantined',
]);

export const attachmentSchema = z.object({
  id: idSchema,
  uploaderId: idSchema,
  serverId: idSchema.nullable(),
  channelId: idSchema.nullable(),
  messageId: idSchema.nullable(),
  kind: attachmentKindSchema,
  filename: z.string().max(512),
  mimeType: z.string().max(128),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  waveform: z.array(z.number().int().min(0).max(255)).nullable(),
  thumbnailUrl: z.string().url().nullable(),
  url: z.string().url().nullable(),
  status: attachmentStatusSchema,
  createdAt: z.string().datetime(),
});

export const requestUploadRequestSchema = z.object({
  kind: attachmentKindSchema,
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().positive(),
  serverId: idSchema.optional(),
  channelId: idSchema.optional(),
});

export const requestUploadResponseSchema = z.object({
  attachment: attachmentSchema,
  upload: z.object({
    method: z.literal('PUT'),
    url: z.string().url(),
    headers: z.record(z.string()),
    expiresAt: z.string().datetime(),
  }),
});

export const completeUploadRequestSchema = z.object({
  attachmentId: idSchema,
});

export type AttachmentKind = z.infer<typeof attachmentKindSchema>;
export type AttachmentStatus = z.infer<typeof attachmentStatusSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type RequestUploadRequest = z.infer<typeof requestUploadRequestSchema>;
export type RequestUploadResponse = z.infer<typeof requestUploadResponseSchema>;
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;
