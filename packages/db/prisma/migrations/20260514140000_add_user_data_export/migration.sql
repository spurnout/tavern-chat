-- CreateTable
CREATE TABLE "UserDataExport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "sizeBytes" INTEGER,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDataExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDataExport_userId_idx" ON "UserDataExport"("userId");

-- CreateIndex
CREATE INDEX "UserDataExport_expiresAt_idx" ON "UserDataExport"("expiresAt");

-- CreateIndex
CREATE INDEX "UserDataExport_status_idx" ON "UserDataExport"("status");

-- AddForeignKey
ALTER TABLE "UserDataExport" ADD CONSTRAINT "UserDataExport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
