-- Federation Phase 2: RemoteUser table + User federation-key columns
-- See docs/federation.md for design notes.

-- CreateTable
CREATE TABLE "RemoteUser" (
    "id" TEXT NOT NULL,
    "remoteInstanceId" TEXT NOT NULL,
    "remoteUserId" TEXT NOT NULL,
    "displayNameCache" TEXT NOT NULL,
    "avatarUrlCache" TEXT,
    "publicKey" BYTEA NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemoteUser_remoteUserId_key" ON "RemoteUser"("remoteUserId");

-- CreateIndex
CREATE INDEX "RemoteUser_remoteInstanceId_idx" ON "RemoteUser"("remoteInstanceId");

-- AddForeignKey
ALTER TABLE "RemoteUser" ADD CONSTRAINT "RemoteUser_remoteInstanceId_fkey" FOREIGN KEY ("remoteInstanceId") REFERENCES "RemoteInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "federationKeyPublic" BYTEA;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "federationKeyPrivate" BYTEA;
