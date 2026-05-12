-- PERM-002: server ban enforcement table.
-- Backs the BAN_MEMBERS permission bit (which existed in code since Phase 0
-- but had no enforcement). Consulted by the gateway IDENTIFY handler to deny
-- reconnects, and by the invite-consume path to block ban-evasion.

-- CreateTable
CREATE TABLE "ServerBan" (
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bannedByUserId" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerBan_pkey" PRIMARY KEY ("serverId","userId")
);

-- CreateIndex
CREATE INDEX "ServerBan_userId_idx" ON "ServerBan"("userId");

-- CreateIndex
CREATE INDEX "ServerBan_expiresAt_idx" ON "ServerBan"("expiresAt");

-- AddForeignKey
ALTER TABLE "ServerBan" ADD CONSTRAINT "ServerBan_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerBan" ADD CONSTRAINT "ServerBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerBan" ADD CONSTRAINT "ServerBan_bannedByUserId_fkey" FOREIGN KEY ("bannedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
