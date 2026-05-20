import { z } from 'zod';

export const profileRequestPayloadSchema = z.object({
  localpart: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/i, 'invalid localpart'),
});

export const profileResponsePayloadSchema = z.object({
  remoteUserId: z.string().min(3).max(253), // "alice@b.example"
  displayName: z.string().min(1).max(120),
  avatarUrl: z.string().url().nullable().optional(),
  publicKey: z.string().regex(/^ed25519:[A-Za-z0-9+/]+=*$/, 'expected ed25519:<base64>'),
});

export type ProfileRequestPayload = z.infer<typeof profileRequestPayloadSchema>;
export type ProfileResponsePayload = z.infer<typeof profileResponsePayloadSchema>;
