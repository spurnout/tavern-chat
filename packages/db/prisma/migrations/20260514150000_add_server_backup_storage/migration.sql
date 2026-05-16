-- AlterTable
ALTER TABLE "ServerBackup"
    ADD COLUMN "storageBucket" TEXT,
    ADD COLUMN "storageKey" TEXT,
    ADD COLUMN "sizeBytes" INTEGER;
