-- Federation Phase 3: message-content federation schema additions.
-- See docs/federation.md for design notes.
--
-- Additions:
--   1. FederationMode enum
--   2. Message.signature (BYTEA) + Message.originInstanceId (TEXT FK → RemoteInstance)
--   3. Server.federationEnabled (BOOLEAN DEFAULT false)
--   4. Channel.federationMode (FederationMode DEFAULT 'inherit')
--   5. User.passwordHash → nullable (remote users have no local password)
--   6. User.remoteUserId (TEXT UNIQUE) + User.remoteInstanceId (TEXT FK → RemoteInstance)

-- CreateEnum
CREATE TYPE "FederationMode" AS ENUM ('inherit', 'force_on', 'force_off');

-- AlterTable: Message — add signature + originInstanceId
ALTER TABLE "Message" ADD COLUMN "signature" BYTEA;
ALTER TABLE "Message" ADD COLUMN "originInstanceId" TEXT;

-- CreateIndex: Message_originInstanceId_idx
CREATE INDEX "Message_originInstanceId_idx" ON "Message"("originInstanceId");

-- AddForeignKey: Message.originInstanceId → RemoteInstance.id
ALTER TABLE "Message" ADD CONSTRAINT "Message_originInstanceId_fkey"
    FOREIGN KEY ("originInstanceId") REFERENCES "RemoteInstance"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Server — add federationEnabled
ALTER TABLE "Server" ADD COLUMN "federationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Channel — add federationMode
ALTER TABLE "Channel" ADD COLUMN "federationMode" "FederationMode" NOT NULL DEFAULT 'inherit';

-- AlterTable: User — make passwordHash nullable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable: User — add remoteUserId + remoteInstanceId
ALTER TABLE "User" ADD COLUMN "remoteUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "remoteInstanceId" TEXT;

-- CreateIndex: User_remoteUserId_key (unique)
CREATE UNIQUE INDEX "User_remoteUserId_key" ON "User"("remoteUserId");

-- AddForeignKey: User.remoteInstanceId → RemoteInstance.id
ALTER TABLE "User" ADD CONSTRAINT "User_remoteInstanceId_fkey"
    FOREIGN KEY ("remoteInstanceId") REFERENCES "RemoteInstance"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
