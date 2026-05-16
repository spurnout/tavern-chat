-- CreateEnum
CREATE TYPE "Presence" AS ENUM ('active', 'idle', 'dnd', 'offline');

-- AlterTable
-- DB-029 follow-up: new DateTime columns use TIMESTAMPTZ(3) to stay
-- consistent with the prior timestamp-conversion migration; the Prisma
-- generator emits plain TIMESTAMP(3) by default, so we override here.
ALTER TABLE "User"
  ADD COLUMN "presence" "Presence" NOT NULL DEFAULT 'offline',
  ADD COLUMN "presenceUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "manualDnd" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UserNotificationPreference" (
    "userId" TEXT NOT NULL,
    "soundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "volume" INTEGER NOT NULL DEFAULT 70,
    "chatSoundsWhileInVoice" BOOLEAN NOT NULL DEFAULT false,
    "playOnlyWhenUnfocused" BOOLEAN NOT NULL DEFAULT true,
    "mentionsOverrideMute" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserNotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ServerMemberNotificationPreference" (
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "muteAll" BOOLEAN NOT NULL DEFAULT false,
    "muteMessages" BOOLEAN NOT NULL DEFAULT false,
    "muteMentions" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServerMemberNotificationPreference_pkey" PRIMARY KEY ("serverId","userId")
);

-- CreateIndex
CREATE INDEX "ServerMemberNotificationPreference_userId_idx" ON "ServerMemberNotificationPreference"("userId");

-- AddForeignKey
ALTER TABLE "UserNotificationPreference" ADD CONSTRAINT "UserNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMemberNotificationPreference" ADD CONSTRAINT "ServerMemberNotificationPreference_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMemberNotificationPreference" ADD CONSTRAINT "ServerMemberNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
