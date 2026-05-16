import { z } from 'zod';

/**
 * Schemas for the WebAuthn / passkey endpoints.
 *
 * The two `verify` bodies receive the full JSON the browser produced via
 * `navigator.credentials.create()` / `.get()`. Schema validation here is
 * deliberately permissive (`z.unknown()`) because the @simplewebauthn/server
 * library does the structural + cryptographic validation; we just want to
 * reject obvious garbage (missing field, wrong shape at the top level).
 */

export const webauthnRegisterStartSchema = z.object({
  // Optional human label so the credential list shows "MacBook TouchID" etc.
  deviceName: z.string().max(120).optional(),
});

export const webauthnRegisterFinishSchema = z.object({
  response: z.unknown(),
  deviceName: z.string().max(120).optional(),
});

export const webauthnLoginStartSchema = z.object({
  /** Username or email. Same surface as the password login form. */
  identifier: z.string().min(1).max(254),
});

export const webauthnLoginFinishSchema = z.object({
  stagedToken: z.string().min(8),
  response: z.unknown(),
});

export type WebauthnRegisterStart = z.infer<typeof webauthnRegisterStartSchema>;
export type WebauthnRegisterFinish = z.infer<typeof webauthnRegisterFinishSchema>;
export type WebauthnLoginStart = z.infer<typeof webauthnLoginStartSchema>;
export type WebauthnLoginFinish = z.infer<typeof webauthnLoginFinishSchema>;
