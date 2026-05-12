-- Phase B.3 — hot-path partial indexes + audit/nonce retention hooks.
-- Closes DB-007 (Session active lookup), DB-008 (ModerationAction FK),
-- DB-009 (AuditLogEntry retention readiness), DB-010 (Message nonce window),
-- and DB-011 (Attachment status partial).

-- DB-007: partial index for active-session lookup. The full-coverage index on
-- userId already exists for FK enforcement; this one accelerates the very
-- common "do I have any unrevoked sessions for this user?" query path used
-- by the per-user session-cap pruning (SEC-009).
CREATE INDEX IF NOT EXISTS "Session_userId_active_idx"
  ON "Session" ("userId")
  WHERE "revokedAt" IS NULL;

-- DB-008: ModerationAction FK indexes — every report-resolution query and
-- per-server audit view filters by one of these.
CREATE INDEX IF NOT EXISTS "ModerationAction_reportId_idx"
  ON "ModerationAction" ("reportId");
CREATE INDEX IF NOT EXISTS "ModerationAction_serverId_idx"
  ON "ModerationAction" ("serverId");

-- DB-011: partial index on attachments still in flight. The full-coverage
-- index includes terminal states (ready/blocked/quarantined) which dwarf the
-- in-flight set, so most lookups against it scan more pages than necessary.
CREATE INDEX IF NOT EXISTS "Attachment_pending_idx"
  ON "Attachment" (status)
  WHERE status IN ('pending', 'processing');

-- DB-010: nonce uniqueness should only apply to non-NULL values. Replace the
-- full-coverage unique index with a partial one and add a non-unique cover
-- index for the 24h cleanup sweep that nulls expired nonces.
DROP INDEX IF EXISTS "Message_channelId_nonce_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Message_channelId_nonce_key"
  ON "Message" ("channelId", nonce)
  WHERE nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Message_nonce_createdAt_idx"
  ON "Message" ("createdAt")
  WHERE nonce IS NOT NULL;
