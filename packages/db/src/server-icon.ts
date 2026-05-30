/**
 * Server-icon URL resolution (federation #23).
 *
 * `Server.iconUrl` is the single source of truth for rendering a server icon
 * as an image — for local web clients and for the federated snapshot /
 * invite-preview / server-update payloads a home instance sends its peers.
 *
 * For a LOCAL server the URL is derived from `iconAttachmentId` through the
 * storage backend's canonical public URL (the same unauthenticated capability
 * URL the app serializes for message attachments — `/api/_attachments/...` for
 * s3, `/api/_local-files/...` for local, made absolute via PUBLIC_BASE_URL).
 * Only `ready` attachments are resolved, so unscanned bytes are never
 * advertised. This mirrors `FederationProfileService.deriveAvatarUrl`.
 *
 * For a MIRROR server the URL is the string received from the home instance;
 * mirrors hold no local attachment, so the mirror lifecycle helpers persist
 * the received URL directly without calling in here.
 *
 * Lives in `@tavern/db` (not `apps/api`) so both the in-process scan queue
 * (api) and the BullMQ worker can reach the scan-complete backfill. Decoupled
 * from `@tavern/media` via the structural `IconUrlResolver` — any object with
 * `getPublicUrl(bucket, key)` satisfies it, including `StorageBackend`.
 */

import { prisma } from './index.js';

/** Minimal storage surface needed to build a public attachment URL. */
export interface IconUrlResolver {
  getPublicUrl(bucket: string, key: string): string;
}

/**
 * Resolve a local server-icon attachment id to a public, peer-fetchable URL.
 * Returns null when there is no icon or the attachment is not `ready` (still
 * scanning, rejected, or missing) — callers store null and the icon simply
 * doesn't render until the attachment becomes ready (see
 * {@link refreshServerIconsForAttachment}).
 */
export async function resolveServerIconUrl(
  iconAttachmentId: string | null,
  storage: IconUrlResolver,
): Promise<string | null> {
  if (!iconAttachmentId) return null;
  const att = await prisma.attachment.findUnique({
    where: { id: iconAttachmentId },
    select: { storageBucket: true, storageKey: true, status: true },
  });
  if (!att || att.status !== 'ready') return null;
  return storage.getPublicUrl(att.storageBucket, att.storageKey);
}

/**
 * Backfill `Server.iconUrl` for every server using `attachmentId` as its icon,
 * called when an attachment reaches a terminal scan status. Covers the race
 * where a server's icon is set (PATCH) before its attachment finished
 * scanning: the PATCH stored a null URL, and this refresh fills it in once the
 * bytes are `ready`. A no-op (0 rows updated) for the common case of non-icon
 * attachments.
 *
 * Resolves to null on a non-`ready` terminal status (failed / blocked /
 * quarantined), so a server pointing at rejected bytes ends with a null URL
 * rather than a broken link.
 */
export async function refreshServerIconsForAttachment(
  attachmentId: string,
  storage: IconUrlResolver,
): Promise<void> {
  const url = await resolveServerIconUrl(attachmentId, storage);
  await prisma.server.updateMany({
    where: { iconAttachmentId: attachmentId },
    data: { iconUrl: url },
  });
}
