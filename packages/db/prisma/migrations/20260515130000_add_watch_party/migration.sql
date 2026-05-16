-- CreateTable
CREATE TABLE "WatchParty" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isPlaying" BOOLEAN NOT NULL DEFAULT false,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchParty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchParty_channelId_key" ON "WatchParty"("channelId");

-- CreateIndex
CREATE INDEX "WatchParty_hostUserId_idx" ON "WatchParty"("hostUserId");

-- AddForeignKey
ALTER TABLE "WatchParty" ADD CONSTRAINT "WatchParty_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchParty" ADD CONSTRAINT "WatchParty_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
