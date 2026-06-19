import { ApiError } from './api-client.js';

// A 5xx means the API itself failed (commonly: it's up but can't reach
// Postgres) — surface an on-voice, recoverable line instead of dumping a raw
// "Internal server error" at the user. Client errors (wrong password, rate
// limits, no-passkey) keep the message the API worded.
export const TAVERN_UNREACHABLE =
  "The tavern can't reach its cellar right now — give it a moment and try again.";

/**
 * Turn a thrown auth error into a user-facing message. Server faults (5xx) map
 * to a friendly, recoverable line; client faults (4xx) keep the API's wording;
 * anything else (network/unexpected) uses the caller's fallback.
 */
export function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.status >= 500 ? TAVERN_UNREACHABLE : err.message;
  }
  return fallback;
}
