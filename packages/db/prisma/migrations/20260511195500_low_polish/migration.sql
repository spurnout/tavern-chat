-- Phase D.2 — remaining FK indexes + redundant index cleanup.

-- DB-024: Invite has both a UNIQUE index and a separate non-unique index on
-- `code`. The unique constraint already serves every read path; the extra
-- index just consumes write bandwidth on invite creation.
DROP INDEX IF EXISTS "Invite_code_idx";

-- DB-025..028: FK indexes on the owner / creator / reporter columns. Without
-- them, a Postgres planner running `DELETE FROM "User" WHERE id = ?`
-- (cascade source) does a full scan of each child table to find dependent
-- rows.
CREATE INDEX IF NOT EXISTS "BoardGame_ownerUserId_idx"
  ON "BoardGame" ("ownerUserId")
  WHERE "ownerUserId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "GameNight_createdById_idx"
  ON "GameNight" ("createdById");
CREATE INDEX IF NOT EXISTS "Report_reporterId_idx"
  ON "Report" ("reporterId");
CREATE INDEX IF NOT EXISTS "CampaignSessionRsvp_userId_idx"
  ON "CampaignSessionRsvp" ("userId");

-- DB-029 (TIMESTAMP(3) → TIMESTAMPTZ) is intentionally deferred. The repo's
-- application code consistently emits ISO-8601 strings via `Date.toISOString`
-- so timestamps are already stored in UTC; the column-type rewrite is a
-- correctness-only improvement against a future feature (multi-region replicas
-- where clocks might be ambiguous). When done, it must be a separate
-- migration so the column rewrite can be timed independently.
