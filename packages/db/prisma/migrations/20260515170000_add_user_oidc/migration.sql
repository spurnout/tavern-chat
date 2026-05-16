-- AlterTable
ALTER TABLE "User"
    ADD COLUMN "oidcIssuer" TEXT,
    ADD COLUMN "oidcSubject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_oidc_idx" ON "User"("oidcIssuer", "oidcSubject");
