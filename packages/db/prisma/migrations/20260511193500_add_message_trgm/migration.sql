-- DB-003: full-text search GIN index for Message.content.
--
-- Tavern's search route uses Prisma `contains` (=> `ILIKE '%term%'` in SQL),
-- which previously did a sequential scan on the whole Message table. The
-- pg_trgm extension's `gin_trgm_ops` operator class lets that same operator
-- use a GIN index, turning an O(N) table scan into an indexed lookup. The
-- partial WHERE excludes soft-deleted rows so the index doesn't grow with
-- tombstones.
--
-- pg_trgm ships with stock Postgres 16; no extra OS install required.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Message_content_trgm_idx"
  ON "Message" USING gin (content gin_trgm_ops)
  WHERE "deletedAt" IS NULL;
