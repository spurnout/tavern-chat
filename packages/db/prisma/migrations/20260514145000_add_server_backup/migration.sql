-- Repairs a missing CREATE TABLE for `ServerBackup`. The base table was
-- originally added via `prisma db push` (or an equivalent dev workflow) and
-- the resulting migration was never committed, so `migrate deploy` in CI
-- couldn't apply the follow-up `20260514150000_add_server_backup_storage`
-- ALTER. This migration creates the table with its initial shape (status +
-- legacy attachmentId pointer); the next migration adds the storage columns.

-- CreateTable
CREATE TABLE "ServerBackup" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attachmentId" TEXT,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerBackup_serverId_createdAt_idx" ON "ServerBackup"("serverId", "createdAt");

-- AddForeignKey
ALTER TABLE "ServerBackup" ADD CONSTRAINT "ServerBackup_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerBackup" ADD CONSTRAINT "ServerBackup_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
