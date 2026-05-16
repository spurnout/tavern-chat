-- Deterministic key for 1:1 DM channels so concurrent calls to
-- findOrCreateDirectDm can't produce duplicate direct DMs for the same pair.
-- pairKey is `string_agg(userId, ':' ORDER BY userId)` over the two members.
-- Group DMs leave it NULL; Postgres treats NULL as distinct in UNIQUE indexes,
-- so multiple group DMs are fine.

ALTER TABLE "DmChannel"
  ADD COLUMN "pairKey" TEXT;

-- Backfill existing direct DMs. Two members per direct channel; we sort by
-- userId so the key is independent of insertion order.
WITH pair_keys AS (
  SELECT
    c.id AS channel_id,
    string_agg(m."userId", ':' ORDER BY m."userId") AS key
  FROM "DmChannel" c
  JOIN "DmChannelMember" m ON m."dmChannelId" = c.id
  WHERE c.kind = 'direct'
  GROUP BY c.id
)
UPDATE "DmChannel" c
SET "pairKey" = pk.key
FROM pair_keys pk
WHERE c.id = pk.channel_id;

-- Unique index lives at the database level so a race between two concurrent
-- POST /api/dms/direct calls surfaces as a 23505 the service can recover from.
-- If this CREATE fails, there is duplicate direct-DM data to consolidate
-- before re-running the migration.
CREATE UNIQUE INDEX "DmChannel_pairKey_key" ON "DmChannel"("pairKey");
