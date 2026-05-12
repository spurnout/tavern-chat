-- DB-029: convert every TIMESTAMP(3) column to TIMESTAMPTZ(3).
--
-- Tavern emits ISO-8601 timestamps in UTC (`Date.toISOString()`) so the
-- stored values are already canonically UTC; this migration changes only
-- how Postgres LABELS them, not what they contain. The `USING ... AT TIME
-- ZONE 'UTC'` clause anchors each existing value at UTC during the rewrite.
--
-- On a populated database each ALTER COLUMN requires an ACCESS EXCLUSIVE
-- lock and a full table rewrite. For tables expected to grow large
-- (Message, AuditLogEntry, Attachment) this should run during a quiet
-- window or be retried with `lock_timeout`/`statement_timeout` set; for
-- small or empty installations it's instant. Document this in the release
-- notes when shipping.
--
-- We use a DO block to skip columns that have already been converted, so
-- re-running on a partially-migrated DB is safe.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND data_type = 'timestamp without time zone'
      AND udt_name = 'timestamp'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE TIMESTAMPTZ(3) USING %I AT TIME ZONE ''UTC''',
      r.table_schema, r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END
$$;
