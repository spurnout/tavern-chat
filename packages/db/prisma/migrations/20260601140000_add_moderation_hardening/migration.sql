-- Parity gap #4: AutoMod presets + raid protection + verification levels.
-- Adds AutomodRule.presetId (preset provenance), RaidProtectionConfig
-- (join-velocity lockdown), Server verification fields, and
-- User.emailVerifiedAt (backs the email_verified tier).

-- CreateEnum
CREATE TYPE "VerificationLevel" AS ENUM ('none', 'email_verified', 'account_age', 'must_pass_gate');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Server" ADD COLUMN "verificationLevel" "VerificationLevel" NOT NULL DEFAULT 'none';
ALTER TABLE "Server" ADD COLUMN "verificationMinAccountAgeHours" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AutomodRule" ADD COLUMN "presetId" TEXT;

-- CreateIndex
CREATE INDEX "AutomodRule_serverId_presetId_idx" ON "AutomodRule"("serverId", "presetId");

-- CreateTable
CREATE TABLE "RaidProtectionConfig" (
    "serverId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "joinWindowSec" INTEGER NOT NULL DEFAULT 60,
    "joinThreshold" INTEGER NOT NULL DEFAULT 10,
    "lockdownAction" TEXT NOT NULL DEFAULT 'require_approval',
    "lockdownActive" BOOLEAN NOT NULL DEFAULT false,
    "lockdownEndsAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaidProtectionConfig_pkey" PRIMARY KEY ("serverId")
);

-- AddForeignKey
ALTER TABLE "RaidProtectionConfig" ADD CONSTRAINT "RaidProtectionConfig_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
