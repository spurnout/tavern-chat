-- Schema-drift repair.
--
-- The prior consolidation work (5c15065, dae85d5, 0f7a557) caught new TABLES
-- that had been applied via `prisma db push` without a generated migration,
-- but missed COLUMN-level adds on existing tables. As a result `migrate
-- deploy` against a fresh DB ran cleanly yet left several columns declared
-- in the Prisma schema with no Postgres counterpart — most visibly the
-- bootstrap insert 500'd against a freshly migrated DB because `User.isBot`
-- (and a number of its neighbours) did not exist.
--
-- This is a single forward-only repair: it adds every drifted column across
-- User, UserNotificationPreference, Channel, Message, Server, and
-- ServerMember, plus the Wave-3 `'stage'` ChannelType value and the Phase-3
-- threading FKs/indexes the schema declares. Every add is idempotent
-- (`IF NOT EXISTS`) so dev DBs that already received these columns via
-- `db push` see no change.
--
-- We deliberately do NOT include the spurious changes that Prisma's
-- `migrate diff` also emits when run against this codebase, even though
-- they show up in its output:
--
--   * `SET DATA TYPE TIMESTAMP(3)` on existing TIMESTAMPTZ columns — the
--     TIMESTAMPTZ override is the deliberate choice per 20260512030000 /
--     DB-029, and reverting it would silently change semantics on every
--     server.
--   * `DROP INDEX` on the DB-018 secondary indexes — those were added
--     deliberately in 20260511195000 for query-planner tuning and aren't
--     declared in the schema by design.
--   * Re-CREATE of `Message_channelId_nonce_key` — the live version is a
--     partial unique (`WHERE nonce IS NOT NULL`) installed by 20260511194000
--     and diff doesn't model partial indexes.
--   * `Invite_code_idx` — explicitly dropped by 20260511195500 as redundant
--     with the unique index on the same column; schema `@@index([code])`
--     is the drift, not the migration.

-- AlterEnum: Wave 3 #24 stage / broadcast voice channel.
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'stage';

-- AlterTable: Channel — Wave 4 moderation knobs (posting scope + slowmode).
ALTER TABLE "Channel"
  ADD COLUMN IF NOT EXISTS "postingScope" "ChannelPostingScope" NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS "slowmodeSeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: Message — Phase 3 threads + message forwarding.
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "forwardedFromChannelId" TEXT,
  ADD COLUMN IF NOT EXISTS "forwardedFromMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "isThreadRoot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "threadId" TEXT;

-- AlterTable: Server — mod-log channel pointer.
ALTER TABLE "Server"
  ADD COLUMN IF NOT EXISTS "modLogChannelId" TEXT;

-- AlterTable: ServerMember — Wave 4 moderation pipeline state.
ALTER TABLE "ServerMember"
  ADD COLUMN IF NOT EXISTS "customStatus" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "gatePassedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "strikeTier" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: User — Wave 2 TOTP + bot + account-delete, Wave 3 appearance
-- and accessibility preferences. The bootstrap insert references isBot,
-- totpEnabled, totpBackupCodes, and reduceMotion directly; the rest are
-- read on every login via Prisma's generated SELECT.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "isBot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "totpSecret" TEXT,
  ADD COLUMN IF NOT EXISTS "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "totpBackupCodes" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "scheduledDeleteAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "themePreference" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "fontPreference" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "reduceMotion" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "localePreference" VARCHAR(20);

-- AlterTable: UserNotificationPreference — Wave 3 #31 snooze + quiet hours.
ALTER TABLE "UserNotificationPreference"
  ADD COLUMN IF NOT EXISTS "snoozeUntil" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "quietHoursStart" VARCHAR(5),
  ADD COLUMN IF NOT EXISTS "quietHoursEnd" VARCHAR(5),
  ADD COLUMN IF NOT EXISTS "quietHoursDays" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex: lookups on the new Message threading / forwarding columns.
CREATE INDEX IF NOT EXISTS "Message_threadId_idx" ON "Message"("threadId");
CREATE INDEX IF NOT EXISTS "Message_forwardedFromMessageId_idx" ON "Message"("forwardedFromMessageId");

-- AddForeignKey: Message → Thread and Message → Message for the new columns.
-- Wrapped in DO blocks so re-runs against dev DBs that already have the
-- constraint stay idempotent (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Message_threadId_fkey'
  ) THEN
    ALTER TABLE "Message"
      ADD CONSTRAINT "Message_threadId_fkey"
      FOREIGN KEY ("threadId") REFERENCES "Thread"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Message_forwardedFromMessageId_fkey'
  ) THEN
    ALTER TABLE "Message"
      ADD CONSTRAINT "Message_forwardedFromMessageId_fkey"
      FOREIGN KEY ("forwardedFromMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
