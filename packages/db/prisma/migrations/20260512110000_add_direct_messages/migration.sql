-- CreateEnum
CREATE TYPE "DmChannelKind" AS ENUM ('direct', 'group');

-- DropForeignKey (server channel FK on Message becomes optional)
ALTER TABLE "Message" DROP CONSTRAINT "Message_channelId_fkey";

-- AlterTable: Message becomes polymorphic over Channel | DmChannel
ALTER TABLE "Message"
  ALTER COLUMN "serverId" DROP NOT NULL,
  ALTER COLUMN "channelId" DROP NOT NULL,
  ADD COLUMN "dmChannelId" TEXT;

-- DropForeignKey
ALTER TABLE "DiceRoll" DROP CONSTRAINT "DiceRoll_channelId_fkey";

-- AlterTable: DiceRoll mirrors Message
ALTER TABLE "DiceRoll"
  ALTER COLUMN "serverId" DROP NOT NULL,
  ALTER COLUMN "channelId" DROP NOT NULL,
  ADD COLUMN "dmChannelId" TEXT;

-- CreateTable
CREATE TABLE "DmChannel" (
    "id" TEXT NOT NULL,
    "kind" "DmChannelKind" NOT NULL,
    "name" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMPTZ(3),

    CONSTRAINT "DmChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmChannelMember" (
    "dmChannelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMPTZ(3),

    CONSTRAINT "DmChannelMember_pkey" PRIMARY KEY ("dmChannelId","userId")
);

-- CreateIndex
CREATE INDEX "DmChannel_lastMessageAt_idx" ON "DmChannel"("lastMessageAt");

-- CreateIndex
CREATE INDEX "DmChannelMember_userId_idx" ON "DmChannelMember"("userId");

-- CreateIndex
CREATE INDEX "Message_dmChannelId_createdAt_idx" ON "Message"("dmChannelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_dmChannelId_nonce_key" ON "Message"("dmChannelId", "nonce");

-- CreateIndex
CREATE INDEX "DiceRoll_dmChannelId_createdAt_idx" ON "DiceRoll"("dmChannelId", "createdAt");

-- AddForeignKey (re-add Message.channelId, now nullable)
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DmChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (re-add DiceRoll.channelId, now nullable)
ALTER TABLE "DiceRoll" ADD CONSTRAINT "DiceRoll_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiceRoll" ADD CONSTRAINT "DiceRoll_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DmChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmChannelMember" ADD CONSTRAINT "DmChannelMember_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DmChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmChannelMember" ADD CONSTRAINT "DmChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
