-- CreateTable
CREATE TABLE "CampaignSafetyEntry" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSafetyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignSafetyEntry_campaignId_createdAt_idx" ON "CampaignSafetyEntry"("campaignId","createdAt");

-- CreateIndex
CREATE INDEX "CampaignSafetyEntry_authorId_idx" ON "CampaignSafetyEntry"("authorId");

-- AddForeignKey
ALTER TABLE "CampaignSafetyEntry" ADD CONSTRAINT "CampaignSafetyEntry_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSafetyEntry" ADD CONSTRAINT "CampaignSafetyEntry_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
