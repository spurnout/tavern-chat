-- Federation Phase 1: RemoteInstance, FederationKey, FederationEnvelopeLog
-- See docs/federation.md for design notes.

-- CreateEnum
CREATE TYPE "RemoteInstanceStatus" AS ENUM ('pending_inbound', 'pending_outbound', 'peered', 'revoked', 'blocked');

-- CreateEnum
CREATE TYPE "FederationEnvelopeDirection" AS ENUM ('inbound', 'outbound');

-- CreateTable
CREATE TABLE "RemoteInstance" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "instanceKey" BYTEA NOT NULL,
    "previousInstanceKey" BYTEA,
    "status" "RemoteInstanceStatus" NOT NULL,
    "capabilities" TEXT[],
    "peeredAt" TIMESTAMP(3),
    "peeredByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "contactEmail" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationKey" (
    "id" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "publicKey" BYTEA NOT NULL,
    "privateKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "FederationKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationEnvelopeLog" (
    "id" TEXT NOT NULL,
    "direction" "FederationEnvelopeDirection" NOT NULL,
    "peerInstanceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" BYTEA NOT NULL,
    "nonce" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,

    CONSTRAINT "FederationEnvelopeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemoteInstance_host_key" ON "RemoteInstance"("host");

-- CreateIndex
CREATE INDEX "RemoteInstance_status_idx" ON "RemoteInstance"("status");

-- CreateIndex
CREATE INDEX "FederationKey_isCurrent_idx" ON "FederationKey"("isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "FederationEnvelopeLog_peerInstanceId_nonce_key" ON "FederationEnvelopeLog"("peerInstanceId", "nonce");

-- CreateIndex
CREATE INDEX "FederationEnvelopeLog_peerInstanceId_receivedAt_idx" ON "FederationEnvelopeLog"("peerInstanceId", "receivedAt");

-- AddForeignKey
ALTER TABLE "FederationEnvelopeLog" ADD CONSTRAINT "FederationEnvelopeLog_peerInstanceId_fkey" FOREIGN KEY ("peerInstanceId") REFERENCES "RemoteInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
