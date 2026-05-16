-- CreateTable
CREATE TABLE "CardDeck" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cardsJson" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardDeck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardDeck_serverId_idx" ON "CardDeck"("serverId");

-- AddForeignKey
ALTER TABLE "CardDeck" ADD CONSTRAINT "CardDeck_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDeck" ADD CONSTRAINT "CardDeck_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
