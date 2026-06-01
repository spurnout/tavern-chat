-- Parity gap #2: rich embeds + interactive message components.
-- Two render-only jsonb columns on Message, plus a mutable MessageInteraction
-- table for press provenance + rate limiting.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "embedsJson" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Message" ADD COLUMN "componentsJson" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "MessageInteraction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageInteraction_messageId_createdAt_idx" ON "MessageInteraction"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageInteraction_userId_createdAt_idx" ON "MessageInteraction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageInteraction" ADD CONSTRAINT "MessageInteraction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageInteraction" ADD CONSTRAINT "MessageInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
