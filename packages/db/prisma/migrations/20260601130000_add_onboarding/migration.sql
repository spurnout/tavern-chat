-- Parity gap #3: member onboarding / welcome screen.
-- Adds Server.systemChannelId (system join messages) plus the self-serve
-- onboarding config (welcome text, recommended rooms, opt-in role prompts).
-- Rules acceptance reuses ServerMember.gatePassedAt — no new column there.

-- AlterTable
ALTER TABLE "Server" ADD COLUMN "systemChannelId" TEXT;

-- CreateTable
CREATE TABLE "ServerOnboarding" (
    "serverId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "welcomeText" TEXT NOT NULL DEFAULT '',
    "recommendedRoomsJson" JSONB NOT NULL DEFAULT '[]',
    "requireRules" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerOnboarding_pkey" PRIMARY KEY ("serverId")
);

-- CreateTable
CREATE TABLE "OnboardingPrompt" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "multiSelect" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingPromptOption" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "roleId" TEXT,
    "channelIdsJson" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OnboardingPromptOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingPrompt_serverId_position_idx" ON "OnboardingPrompt"("serverId", "position");

-- CreateIndex
CREATE INDEX "OnboardingPromptOption_promptId_position_idx" ON "OnboardingPromptOption"("promptId", "position");

-- AddForeignKey
ALTER TABLE "ServerOnboarding" ADD CONSTRAINT "ServerOnboarding_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingPrompt" ADD CONSTRAINT "OnboardingPrompt_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "ServerOnboarding"("serverId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingPromptOption" ADD CONSTRAINT "OnboardingPromptOption_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "OnboardingPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
