-- Federation #23 — resolved server-icon URL.
--
-- Adds the single source of truth for rendering a server icon as an image.
-- Local servers populate it by resolving `iconAttachmentId` through the
-- storage backend (ready attachments only); mirror servers store the public
-- URL received from their home instance (a mirror holds no local attachment,
-- so `iconAttachmentId` stays null on mirrors). Nullable + no default — every
-- existing row keeps a null icon URL until its next icon write / scan-ready.

ALTER TABLE "Server" ADD COLUMN "iconUrl" TEXT;
