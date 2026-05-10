import { z } from 'zod';

/**
 * Tavern uses ULIDs (Crockford base32, 26 chars) for all primary keys.
 * They sort lexicographically by creation time and are URL-safe.
 */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const idSchema = z
  .string()
  .regex(ULID_REGEX, 'Invalid id (expected ULID)')
  .describe('ULID');

export type Id = z.infer<typeof idSchema>;
