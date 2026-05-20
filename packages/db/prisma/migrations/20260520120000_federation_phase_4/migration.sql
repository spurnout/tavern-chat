-- Federation Phase 4: cross-instance invites + mirror provenance.
-- See docs/federation.md for design notes.
--
-- Additions:
--   1. RemoteInviteScope enum (any_peer | specific_instance | specific_user)
--   2. Invite.remoteScope (nullable) + Invite.remoteInstanceHost + Invite.remoteUserId
--   3. Server.originInstanceId (TEXT FK -> RemoteInstance) — null = local; non-null = mirror
--   4. Channel.originInstanceId (TEXT FK -> RemoteInstance) — same semantics
--   5. Indexes on the two new origin columns

-- CreateEnum
CREATE TYPE "RemoteInviteScope" AS ENUM ('any_peer', 'specific_instance', 'specific_user');

-- AlterTable: Invite — federated invite fields (all nullable; null = local-only)
ALTER TABLE "Invite" ADD COLUMN "remoteScope" "RemoteInviteScope";
ALTER TABLE "Invite" ADD COLUMN "remoteInstanceHost" TEXT;
ALTER TABLE "Invite" ADD COLUMN "remoteUserId" TEXT;

-- AlterTable: Server — mirror provenance
ALTER TABLE "Server" ADD COLUMN "originInstanceId" TEXT;

-- CreateIndex: Server_originInstanceId_idx
CREATE INDEX "Server_originInstanceId_idx" ON "Server"("originInstanceId");

-- AddForeignKey: Server.originInstanceId -> RemoteInstance.id (SetNull on delete)
ALTER TABLE "Server" ADD CONSTRAINT "Server_originInstanceId_fkey"
    FOREIGN KEY ("originInstanceId") REFERENCES "RemoteInstance"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Channel — mirror provenance
ALTER TABLE "Channel" ADD COLUMN "originInstanceId" TEXT;

-- CreateIndex: Channel_originInstanceId_idx
CREATE INDEX "Channel_originInstanceId_idx" ON "Channel"("originInstanceId");

-- AddForeignKey: Channel.originInstanceId -> RemoteInstance.id (SetNull on delete)
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_originInstanceId_fkey"
    FOREIGN KEY ("originInstanceId") REFERENCES "RemoteInstance"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
