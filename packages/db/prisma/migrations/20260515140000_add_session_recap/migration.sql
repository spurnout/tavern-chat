-- CreateTable
CREATE TABLE "SessionRecap" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "sessionId" TEXT,
    "body" TEXT NOT NULL,
    "modelUsed" TEXT NOT NULL,
    "generatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionRecap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionRecap_campaignId_createdAt_idx" ON "SessionRecap"("campaignId","createdAt");

-- AddForeignKey
ALTER TABLE "SessionRecap" ADD CONSTRAINT "SessionRecap_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRecap" ADD CONSTRAINT "SessionRecap_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CampaignSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRecap" ADD CONSTRAINT "SessionRecap_generatedBy_fkey" FOREIGN KEY ("generatedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
