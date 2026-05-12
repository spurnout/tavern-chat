-- Backfill STREAM_SCREEN (bit 27 = 134217728) into every existing @everyone role
-- so the updated PERMISSION_DEFAULT_EVERYONE bundle in @tavern/shared applies
-- to servers that were created before this migration.
--
-- Permissions are stored as Decimal(20,0); cast to bigint for the bitwise OR,
-- then cast back to numeric for storage. The trailing AND clause skips rows
-- that already have the bit set (idempotent re-runs are a no-op).
UPDATE "Role"
SET    "permissions" = ((("permissions")::bigint) | 134217728)::numeric
WHERE  "isEveryone" = true
  AND  ((("permissions")::bigint) & 134217728) = 0;
