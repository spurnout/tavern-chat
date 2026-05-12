-- Phase C.4 — FK indexes, partial indexes, miscellaneous DB tuning.
-- Closes DB-015, DB-016..019, DB-021, DB-023 (doc), DB-024 (overlap), and the
-- remaining read-path index gaps from the database review.

-- DB-015: partial index on active sessions, ordered by expiresAt. The full
-- expiresAt index also covers revoked rows (which dwarf the active set on
-- long-lived instances); the partial avoids walking them when computing
-- "sessions about to expire".
CREATE INDEX IF NOT EXISTS "Session_expiresAt_active_idx"
  ON "Session" ("expiresAt")
  WHERE "revokedAt" IS NULL;

-- DB-016: FK indexes on Channel relations that are joined from Campaign /
-- GameNight detail views. Prisma auto-generates an index on every relation
-- column only in some recent versions; we add them explicitly to avoid
-- depending on that behaviour.
CREATE INDEX IF NOT EXISTS "Channel_campaignId_idx"
  ON "Channel" ("campaignId")
  WHERE "campaignId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Channel_gameNightId_idx"
  ON "Channel" ("gameNightId")
  WHERE "gameNightId" IS NOT NULL;

-- DB-017: handout visibility lookup by user.
CREATE INDEX IF NOT EXISTS "HandoutVisibleUser_userId_idx"
  ON "HandoutVisibleUser" ("userId");

-- DB-018: campaign-note and handout author lookups.
CREATE INDEX IF NOT EXISTS "CampaignNote_authorId_idx"
  ON "CampaignNote" ("authorId");
CREATE INDEX IF NOT EXISTS "Handout_authorId_idx"
  ON "Handout" ("authorId");

-- DB-019: dice-roll per-user lookups (filter "my rolls").
CREATE INDEX IF NOT EXISTS "DiceRoll_userId_idx"
  ON "DiceRoll" ("userId");

-- DB-021: message paging uses `WHERE channelId = ? AND id < cursor ORDER BY id`.
-- The existing index keys on (channelId, createdAt) which happens to work
-- because ULIDs are time-ordered, but the planner is happier with an index
-- whose key matches the ORDER BY column exactly.
CREATE INDEX IF NOT EXISTS "Message_channelId_id_idx"
  ON "Message" ("channelId", "id");
