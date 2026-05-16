-- CreateTable
CREATE TABLE "BreakoutGroup" (
    "id" TEXT NOT NULL,
    "parentChannelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "livekitRoom" TEXT NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "BreakoutMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BreakoutGroup_livekitRoom_key" ON "BreakoutGroup"("livekitRoom");

-- CreateIndex
CREATE INDEX "BreakoutGroup_parentChannelId_idx" ON "BreakoutGroup"("parentChannelId");

-- AddForeignKey
ALTER TABLE "BreakoutGroup" ADD CONSTRAINT "BreakoutGroup_parentChannelId_fkey" FOREIGN KEY ("parentChannelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutGroup" ADD CONSTRAINT "BreakoutGroup_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutMember" ADD CONSTRAINT "BreakoutMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BreakoutGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutMember" ADD CONSTRAINT "BreakoutMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
