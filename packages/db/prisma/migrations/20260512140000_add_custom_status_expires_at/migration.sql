-- Track 3: optional expiration timestamp for the user's custom status.
-- A worker maintenance job nulls out customStatus + customStatusExpiresAt
-- once expiry passes, and broadcasts MEMBER_UPDATE so open profile cards
-- on other clients refresh.
ALTER TABLE "User"
  ADD COLUMN "customStatusExpiresAt" TIMESTAMPTZ(3);

CREATE INDEX "User_customStatusExpiresAt_idx"
  ON "User" ("customStatusExpiresAt");
