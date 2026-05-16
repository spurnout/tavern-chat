-- Repairs a missing CREATE TABLE for `SoundboardClip`. Like `ServerBackup`
-- the base table was created via `prisma db push` in dev and the generated
-- migration was never committed, so the follow-up
-- `20260515090000_soundboard_ambient` ALTER (adding `isAmbient`) has nothing
-- to apply against. This migration creates the table with its initial
-- shape (no `isAmbient` column — that's what `_soundboard_ambient` adds).

-- CreateTable
CREATE TABLE "SoundboardClip" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoundboardClip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SoundboardClip_serverId_position_idx" ON "SoundboardClip"("serverId", "position");

-- AddForeignKey
ALTER TABLE "SoundboardClip" ADD CONSTRAINT "SoundboardClip_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoundboardClip" ADD CONSTRAINT "SoundboardClip_addedBy_fkey" FOREIGN KEY ("addedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
